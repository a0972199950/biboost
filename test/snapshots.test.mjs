// 給擴充讀的 KV 快照（tools/report-worker/src/snapshots.js、scripts/lib/kv-snapshot.mjs）與匿名統計的每日彙總（telemetry.js）。
// 全天都有人打的 GET 不能每個請求都查 Neon；改了資料一定要重寫快照，漏一個擴充就看到舊資料。
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshotsTouchedBy, snapshotKey, envNameOf, encodeSnapshot, decodeSnapshot, buildSnapshot, liveLotteries, liveAnnouncements, liveSurveys,
  readSnapshot, refreshAllSnapshots, _resetSnapshotMemory, TABLE_SNAPSHOTS,
} from "../tools/report-worker/src/snapshots.js";
import { rollupQueries, rollupDay, scheduledRollup, recentTriggers, writePoint, addDays, aeClient, ROW_LIMIT } from "../tools/report-worker/src/telemetry.js";
import { runDaily, markDeployed } from "../tools/report-worker/src/daily.js";
import { flushSnapshots, markWrite, pendingSnapshots } from "../scripts/lib/kv-snapshot.mjs";
import { spawnSync } from "node:child_process";
import { handleAdminApi } from "../scripts/lib/admin-api.mjs";
import { makeSession } from "../scripts/lib/admin-auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);

describe("快照：哪些寫入會讓哪些快照過期", () => {
  test("insert／update／delete／truncate 認得表名；on conflict do update、alter table、select 不算", () => {
    const s = (q) => [...snapshotsTouchedBy(q)].sort();
    assert.deepEqual(s("insert into announcements (type, title) values ($1, $2)"), ["announcements"]);
    assert.deepEqual(s("UPDATE lotteries_v2 SET ended_at = now() WHERE id = $1"), ["announcements", "lotteries"]);
    assert.deepEqual(s("delete from features where key = $1"), ["features"]);
    assert.deepEqual(s(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`), [], "settings 不算（測速報告快照也寫這張表）");
    assert.deepEqual(s("insert into public.features (key, data) values ($1, $2)"), ["features"], "帶 schema");
    assert.deepEqual(s("update /* 註解 */ announcements set title = $1"), ["announcements"], "中間夾註解");
    assert.deepEqual(s("merge into surveys s using x on true when matched then update set status = 'x'"), ["surveys"]);
    assert.deepEqual(s("-- update announcements set x = 1\nselect 1"), [], "註解掉的不算");
    assert.deepEqual(s("truncate lotteries_v2, public.surveys restart identity"), ["announcements", "lotteries", "surveys"], "truncate 好幾張表");
    assert.deepEqual(s("select '--' as x; update features set data = $1"), ["features"], "字串裡的 -- 不是註解");
    assert.deepEqual(s("update surveys set status = 'published' where id = $1"), ["surveys"]);
    assert.deepEqual(s("insert into survey_responses (response_id) values ($1) on conflict (response_id) do update set answers = excluded.answers"), []);
    assert.deepEqual(s("alter table lotteries add column if not exists country text"), [], "只改 schema");
    assert.deepEqual(s("select * from lotteries where id = $1"), []);
    assert.deepEqual(s("with x as (select 1) update announcements set title = $1"), ["announcements"]);
  });

  // 檢查清單：所有改這些表的 SQL 都要經過 scripts/lib/lotteries.mjs 的 sql()（才會標記）；直接打 Neon 的程式不能改這些表
  test("直接打 Neon（不經過 sql()）的程式都不會改到快照的表", () => {
    // 自動找：scripts、tools 底下所有直接打 Neon HTTP 或用 neonSql 的檔案（新增的檔案也會被檢查）。
    // 例外：scripts/lib/lotteries.mjs 就是 sql() 本身；snapshots.js、telemetry.js、daily.js 是快照與統計的實作
    const SKIP = ["scripts/lib/lotteries.mjs", "tools/report-worker/src/snapshots.js", "tools/report-worker/src/telemetry.js", "tools/report-worker/src/daily.js"].map(path.normalize);
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? (["node_modules", "dist", ".wrangler"].includes(d.name) ? [] : walk(path.join(dir, d.name))) : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
    const files = walk("scripts").concat(walk("tools")).filter((f) => !SKIP.includes(path.normalize(f)) && /Neon-Connection-String|neonSql\(/.test(read(f)));
    assert.ok(files.length >= 4, files.join(", "));
    for (const f of files) {
      const text = read(f);
      // surveys.js 的 countCompleted 會改 surveys：它自己會重建問卷快照（額滿時），其他的不能改
      const touched = [...snapshotsTouchedBy(text)].filter((n) => !(f.endsWith("surveys.js") && n === "surveys"));
      assert.deepEqual(touched, [], `${f} 改到 ${touched.join("、")}：要改成經過 sql()，或自己重寫快照`);
    }
  });

  test("每個會用到資料庫的 CLI 都呼叫 useExitFlush()（結束前重寫快照）", () => {
    const imp = (file) => [...read(file).matchAll(/from\s+["'](\.{1,2}\/[^"']+\.mjs)["']|import\(\s*["'](\.{1,2}\/[^"']+\.mjs)["']\s*\)/g)]
      .map((m) => path.normalize(path.join(path.dirname(file), m[1] || m[2])));
    const memo = new Map();
    const reaches = (file, seen = new Set()) => {
      const key = path.normalize(file);
      if (memo.has(key)) return memo.get(key);
      if (seen.has(key)) return false;
      seen.add(key);
      if (key === path.normalize("scripts/lib/lotteries.mjs")) return true;
      if (!fs.existsSync(path.join(ROOT, key))) return false;
      const r = imp(key).some((f) => reaches(f, seen));
      memo.set(key, r);
      return r;
    };
    // scripts/ 底下所有 .mjs（含子資料夾），扣掉 scripts/lib（那是函式庫，不是 CLI）
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? (d.name === "lib" || d.name === "node_modules" ? [] : walk(path.join(dir, d.name))) : d.name.endsWith(".mjs") ? [path.join(dir, d.name)] : []);
    const clis = walk("scripts").filter((f) => reaches(f));
    assert.ok(clis.length >= 5, "找得到用資料庫的 CLI");
    const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""); // 寫在註解裡的不算
    for (const f of clis) assert.match(code(f), /^\s*useExitFlush\(/m, `${f} 用到 sql()，要在開頭呼叫 useExitFlush()`);
  });

  test("sql()：0 列不標記；斷線、5xx 照樣標記（可能已寫入只是回應丟了）；4xx（查詢錯了）不標記", async () => {
    const L = await import("../scripts/lib/lotteries.mjs");
    const realFetch = globalThis.fetch;
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://ep-test.ap-southeast-1.aws.neon.tech/db";
    const drain = () => flushSnapshots(async () => {}, { sqlFor: () => async () => ({}) });
    const q = "update features set data = $1 where key = $2";
    const cases = [
      ["0 列", async () => new Response(JSON.stringify({ rows: [], rowCount: 0 })), false],
      ["1 列", async () => new Response(JSON.stringify({ rows: [], rowCount: 1 })), true],
      ["斷線", async () => { throw new TypeError("fetch failed"); }, true],
      ["503", async () => new Response("unavailable", { status: 503 }), true],
      ["400", async () => new Response('{"message":"syntax error"}', { status: 400 }), false],
    ];
    try {
      for (const [label, fake, marked] of cases) {
        await drain();
        globalThis.fetch = fake;
        await L.sql(q, ["{}", "donate"]).catch(() => {});
        assert.equal(pendingSnapshots().length > 0, marked, label);
      }
    } finally { globalThis.fetch = realFetch; await drain(); }
  });

  test("每張表都對到存在的快照", () => {
    for (const [t, names] of Object.entries(TABLE_SNAPSHOTS)) for (const n of names) assert.ok(["announcements", "lotteries", "features", "surveys"].includes(n), t);
  });
});

describe("快照：內容與 worker 的時間判斷", () => {
  test("key 依環境分開；環境認不得就丟錯（不猜正式）；格式有版本與形狀，壞掉的值當作沒有", () => {
    assert.equal(snapshotKey("surveys", "prod"), "snap:surveys:prod");
    assert.equal(snapshotKey("surveys", "staging"), "snap:surveys:staging");
    assert.throws(() => snapshotKey("surveys", "whatever"));
    assert.throws(() => envNameOf({}), /SNAPSHOT_ENV/);
    assert.throws(() => envNameOf({ SNAPSHOT_ENV: "Staging" }));
    assert.equal(envNameOf({ SNAPSHOT_ENV: "staging" }), "staging");
    assert.deepEqual(decodeSnapshot(encodeSnapshot([1], 5)), { v: 1, at: 5, data: [1] });
    assert.equal(decodeSnapshot("not json"), null);
    assert.equal(decodeSnapshot({ v: 2, data: [] }), null);
    assert.equal(decodeSnapshot(encodeSnapshot([1]), "announcements"), null, "公告應該是 { v1, v2 }");
    assert.equal(decodeSnapshot(encodeSnapshot({ v1: [] }), "lotteries"), null);
    assert.ok(decodeSnapshot(encodeSnapshot({ v1: [], v2: [] }), "lotteries"));
    assert.equal(decodeSnapshot(encodeSnapshot([]), "features"), null);
  });

  test("抽獎、公告、問卷：還沒開始與已經結束的不給", () => {
    const L = (id, s, e) => ({ id, startsAt: s, endsAt: e });
    assert.deepEqual(liveLotteries([L(1, NOW - 1, NOW + 1), L(2, NOW + 10, NOW + 20), L(3, NOW - 20, NOW)], NOW).map((x) => x.id), [1]);
    const ann = [{ id: 1, type: "html" }, { id: 2, type: "lottery", lottery: L(9, NOW + 5, NOW + 9) }, { id: 3, type: "lottery", lottery: L(8, NOW - 5, NOW + 9) }];
    assert.deepEqual(liveAnnouncements(ann, NOW).map((a) => a.id), [1, 3]);
    assert.deepEqual(liveSurveys([L("a", null, null), L("b", NOW + 1, null), L("c", null, NOW)], NOW).map((x) => x.id), ["a"]);
  });

  // Neon 真的錯誤長這樣（HTTP 400，JSON 裡的引號有跳脫）
  const relErr = (t) => new Error(`neon_400 {"message":"relation \\"${t}\\" does not exist","code":"42P01"}`);
  test("建快照：只有「那張表不存在」才當作空的（並記下 info.missing）；其他錯誤一律丟出來", async () => {
    const missingAll = async (q) => { throw relErr(/lotteries_v2/.test(q) ? "lotteries_v2" : /from lotteries/.test(q) ? "lotteries" : "surveys"); };
    const info = {};
    assert.deepEqual(await buildSnapshot("lotteries", missingAll, info), { v1: [], v2: [] });
    assert.equal(info.missing, true);
    assert.deepEqual(await buildSnapshot("surveys", missingAll), []);
    const legacy = async (q) => { if (/from features/.test(q)) throw relErr("features"); return [{ value: false }]; };
    assert.deepEqual(await buildSnapshot("features", legacy), { donate: { enabled: false } });
    // 欄位不存在、資料庫不存在、別張表不存在：都不能變成一份空的快照
    await assert.rejects(buildSnapshot("lotteries", async () => { throw new Error(`neon_400 {"message":"column v.note does not exist","code":"42703"}`); }), /column/);
    await assert.rejects(buildSnapshot("features", async () => { throw new Error('Neon 400：database "x" does not exist'); }), /database/);
    await assert.rejects(buildSnapshot("surveys", async () => { throw relErr("survey_events"); }), /survey_events/);
    await assert.rejects(buildSnapshot("features", async () => { throw new Error("neon_500 boom"); }), /boom/);
  });

  test("抽獎快照放的是還沒結束的（含還沒開始），查詢條件不再用 now() >= starts_at", async () => {
    const seen = [];
    await buildSnapshot("lotteries", async (q) => { seen.push(q); return []; });
    await buildSnapshot("announcements", async (q) => { seen.push(q); return []; });
    for (const q of seen) assert.ok(!/now\(\)\s*>=\s*\w+\.starts_at/.test(q), q.slice(0, 80));
    // （公告先查一次改版的欄位在不在：information_schema，不是資料查詢）
    assert.ok(seen.filter((q) => !/information_schema/.test(q)).every((q) => /ends_at > now\(\)/.test(q)));
  });

  // 公告改版（2026-11-21）：三種類型、公告自己的期間、舊版擴充相容
  const LOT_V2 = { v_id: 6, v_title: { en: "Draw" }, v_country: "SG", v_currency: "SGD", v_gift_cards: [{ name: "A", amount: 10 }], v_note: null, v_isps: null,
    v_winners: 2, v_draw_days: 7, v_start_date: "2026-11-01", v_end_date: "2026-11-30", v_draw_by: "2026-12-07", v_starts_ms: NOW - 1000, v_ends_ms: NOW + 1000 };
  const ANN_ROWS = [
    { id: 1, type: "html", prefix: null, title: { en: "Hi" }, html: { en: "<p>x</p>" }, countries: null, survey_id: null, a_starts_ms: null, a_ends_ms: null },
    { id: 2, type: "lottery", prefix: { en: "SG$10:" }, title: { en: "Draw" }, html: null, countries: ["SG"], survey_id: null, a_starts_ms: NOW - 5, a_ends_ms: null, ...LOT_V2 },
    { id: 3, type: "survey", prefix: null, title: { en: "Survey" }, html: null, countries: null, survey_id: "sample-survey", a_starts_ms: NOW - 5, a_ends_ms: NOW + 50 },
    { id: 4, type: "lottery", prefix: null, title: null, html: null, countries: null, survey_id: null, a_starts_ms: null, a_ends_ms: null, ...LOT_V2 },
  ];
  test("公告快照：三種類型的形狀；舊版認得的欄位不變（html 的 title／html／countries、lottery 的 lottery）", async () => {
    const seen = [];
    const q = async (sql) => {
      seen.push(sql);
      if (/information_schema/.test(sql)) return [{ column_name: "survey_id" }, { column_name: "starts_at" }, { column_name: "ends_at" }];
      return /lotteries_v2/.test(sql) ? ANN_ROWS : ANN_ROWS.filter((r) => r.type === "html");
    };
    const d = await buildSnapshot("announcements", q);
    assert.deepEqual(d.v2.map((a) => a.type), ["html", "lottery", "survey", "lottery"]);
    assert.deepEqual(d.v2[0], { id: 1, type: "html", prefix: null, title: { en: "Hi" }, html: { en: "<p>x</p>" }, countries: null, startsAt: null, endsAt: null });
    assert.equal(d.v2[1].lottery.id, 6, "抽獎公告照舊附抽獎資料（舊版用它組字）");
    assert.deepEqual([d.v2[1].prefix, d.v2[1].title, d.v2[1].countries, d.v2[1].startsAt], [{ en: "SG$10:" }, { en: "Draw" }, ["SG"], NOW - 5]);
    assert.deepEqual(d.v2[2], { id: 3, type: "survey", surveyId: "sample-survey", prefix: null, title: { en: "Survey" }, countries: null, startsAt: NOW - 5, endsAt: NOW + 50 });
    assert.equal(d.v2[3].startsAt, null, "改版前自動建的：沒有自己的期間");
    const [v1Sql, v2Sql] = seen.filter((s) => /from announcements/.test(s));
    assert.ok(!/'survey'/.test(v1Sql), "問卷公告不放進 /v1（只有舊版讀）");
    assert.ok(/a\.type = 'survey'/.test(v2Sql));
    assert.ok(/a\.ends_at is null or a\.ends_at > now\(\)/.test(v2Sql), "公告自己的期間還沒結束的才放");
    assert.ok(/least\(v\.ended_at, v\.ends_at\)/.test(v2Sql), "提前結束的抽獎：endsAt 是結束那一刻（舊版靠它判斷不顯示）");
  });
  test("公告快照：正式環境的 schema 還沒升級（沒有新欄位）時照舊建得出來", async () => {
    const seen = [];
    const d = await buildSnapshot("announcements", async (sql) => { seen.push(sql); return /information_schema/.test(sql) ? [] : []; });
    assert.deepEqual(d, { v1: [], v2: [] });
    const qs = seen.filter((s) => /from announcements/.test(s));
    assert.equal(qs.length, 2);
    for (const s of qs) {
      assert.ok(!/a\.starts_at|a\.ends_at|a\.survey_id/.test(s), "不能讀還不存在的欄位：" + s.slice(0, 120));
      assert.ok(!/'survey'/.test(s));
    }
  });
  test("worker 篩公告：有自己期間的看公告期間（抽獎結束了照樣給）；沒有期間的一般公告一直給；改版前的抽獎公告跟著抽獎", () => {
    const lot = (s, e) => ({ id: 9, startsAt: s, endsAt: e });
    const items = [
      { id: 1, type: "html", startsAt: null, endsAt: null },
      { id: 2, type: "html", startsAt: NOW + 10, endsAt: null },
      { id: 3, type: "html", startsAt: null, endsAt: NOW },
      { id: 4, type: "lottery", lottery: lot(NOW - 20, NOW - 10), startsAt: NOW - 30, endsAt: null },
      { id: 5, type: "lottery", lottery: lot(NOW - 20, NOW - 10), startsAt: null, endsAt: null },
      { id: 6, type: "lottery", lottery: lot(NOW - 20, NOW + 10), startsAt: null, endsAt: null },
      { id: 7, type: "survey", surveyId: "x", startsAt: NOW - 1, endsAt: NOW + 1 },
      { id: 8, type: "survey", surveyId: "x", startsAt: NOW + 1, endsAt: null },
      { id: 10, type: "lottery", lottery: lot(NOW - 20, NOW + 10), startsAt: NOW + 5, endsAt: null },
    ];
    assert.deepEqual(liveAnnouncements(items, NOW).map((a) => a.id), [1, 4, 6, 7]);
  });

  // 實際流量：同一個 isolate 兩次請求多半隔超過 60 秒，所以用 90 秒的間隔測
  test("worker 讀快照：KV 讀取出錯時不查 Neon（有舊的用舊的，沒有就丟錯）", async () => {
    _resetSnapshotMemory();
    let neon = 0;
    const fb = async () => { neon++; return { a: {} }; };
    const down = { SNAPSHOT_ENV: "prod", RATE_KV: { get: async () => { throw new Error("kv down"); }, put: async () => {} } };
    for (let i = 0; i < 20; i++) await assert.rejects(readSnapshot(down, "features", fb, NOW + i * 90_000), /snapshot_unavailable/);
    assert.equal(neon, 0, "KV 壞掉時不能每個請求都叫醒 Neon");
    // 之前讀到過：KV 壞掉時沿用舊的（撐 10 分鐘），也不查 Neon
    _resetSnapshotMemory();
    const ok = { SNAPSHOT_ENV: "prod", RATE_KV: { get: async () => JSON.parse(encodeSnapshot({ old: {} })), put: async () => {} } };
    assert.deepEqual(await readSnapshot(ok, "features", fb, NOW), { old: {} });
    for (let i = 1; i < 10; i++) assert.deepEqual(await readSnapshot(down, "features", fb, NOW + i * 90_000), { old: {} });
    assert.equal(neon, 0);
  });

  test("worker 讀快照：KV 沒有這份才查 Neon；寫回 KV 失敗（例如額度用完）時 10 分鐘內不再查", async () => {
    _resetSnapshotMemory();
    let neon = 0;
    const fb = async () => { neon++; return { a: {} }; };
    const full = { SNAPSHOT_ENV: "prod", RATE_KV: { get: async () => null, put: async () => { throw new Error("KV put limit exceeded"); } } };
    for (let i = 0; i < 20; i++) assert.deepEqual(await readSnapshot(full, "features", fb, NOW + i * 90_000), { a: {} });
    assert.equal(neon, 3, "30 分鐘裡每 10 分鐘最多一次");
    // Neon 也壞了：用記憶體裡舊的，不讓公告整個消失
    assert.deepEqual(await readSnapshot(full, "features", async () => { throw new Error("neon down"); }, NOW + 3_600_000), { a: {} });
  });

  test("worker 讀快照：有表不存在被當成空的，不寫回 KV", async () => {
    _resetSnapshotMemory();
    const puts = [];
    const env = { SNAPSHOT_ENV: "staging", RATE_KV: { get: async () => null, put: async (k, v) => { puts.push(k); } } };
    const data = await readSnapshot(env, "surveys", (info) => buildSnapshot("surveys", async () => { throw relErr("surveys"); }, info), NOW);
    assert.deepEqual(data, []);
    assert.deepEqual(puts, []);
    // 形狀不對的 KV 值：當作沒有，查 Neon 並寫回對的
    _resetSnapshotMemory();
    const bad = { SNAPSHOT_ENV: "prod", RATE_KV: { get: async () => JSON.parse(encodeSnapshot("broken")), put: async (k, v) => { puts.push(k); } } };
    assert.deepEqual(await readSnapshot(bad, "surveys", async () => [{ id: "a" }], NOW), [{ id: "a" }]);
    assert.deepEqual(puts, ["snap:surveys:prod"]);
  });
});

describe("快照：寫入端", () => {
  test("flush：重建過期的快照、一次寫進 KV；寫失敗就把標記放回去", async () => {
    markWrite("staging", "update announcements set title = $1");
    markWrite("prod", "update features set data = $1");
    const built = [];
    const sqlFor = (db) => async (name) => { built.push(`${db}:${name}`); return { from: `${db}:${name}` }; };
    await assert.rejects(flushSnapshots(async () => { throw new Error("wrangler 失敗"); }, { sqlFor }), /wrangler/);
    assert.deepEqual(pendingSnapshots().sort(), [["prod", ["features"]], ["staging", ["announcements"]]], "標記還在");
    let wrote = [];
    await flushSnapshots(async (entries) => { wrote = entries; }, { sqlFor });
    assert.deepEqual(wrote.map((e) => e.key).sort(), ["snap:announcements:staging", "snap:features:prod"]);
    assert.deepEqual(decodeSnapshot(wrote.find((e) => e.key === "snap:features:prod").value).data, { from: "prod:features" });
    assert.deepEqual(pendingSnapshots(), []);
    assert.deepEqual([...(await flushSnapshots(async () => { throw new Error("不該被叫"); }, { sqlFor }))], [], "沒有過期的就不寫");
  });

  // 後台存檔（雲端：寫 site worker 的 RATE_KV）：用 features 的 setFeature 走一遍真的 admin-api 與 sql()
  describe("後台動作做完就寫 KV", () => {
    const realFetch = globalThis.fetch;
    const KEY = "k".repeat(40);
    let db, kv;
    beforeEach(() => {
      process.env.DATABASE_URL = "postgres://ep-test.ap-southeast-1.aws.neon.tech/db";
      db = { features: { donate: { enabled: true } } };
      kv = new Map();
      globalThis.fetch = async (url, init) => {
        if (!String(url).includes("neon.tech/sql")) throw new Error("unexpected fetch " + url);
        const { query, params } = JSON.parse(init.body);
        let rows = [];
        if (/to_regclass/.test(query)) rows = [{ t: null }];
        else if (/^select key, data from features$/.test(query.trim())) rows = Object.entries(db.features).map(([key, data]) => ({ key, data }));
        else if (/^insert into features \(key, data\) values/.test(query)) db.features[params[0]] = JSON.parse(params[1]);
        else if (/^select data from features where key = \$1/.test(query)) rows = db.features[params[0]] ? [{ data: db.features[params[0]] }] : [];
        else if (/^select key, data, updated_at from features/.test(query)) rows = Object.entries(db.features).map(([key, data]) => ({ key, data, updated_at: "t" }));
        return new Response(JSON.stringify({ rows }), { status: 200 });
      };
    });
    after(() => { globalThis.fetch = realFetch; });
    const call = async (name, args, kvBinding) => handleAdminApi(new Request(`https://biboost.app/admin/api/${name}`, {
      method: "POST", body: JSON.stringify({ args }),
      headers: { "Content-Type": "application/json", "X-BB-Admin": "1", Origin: "https://biboost.app", Cookie: `__Host-bb_admin=${await makeSession(KEY)}` },
    }), { local: false, ip: "1.2.3.4", limiter: { get: async () => 0, incr: async () => {} }, env: { ADMIN_USER: "me", ADMIN_PASS_HASH: "x", ADMIN_SESSION_KEY: KEY, RATE_KV: kvBinding } });

    test("改功能開關 → snap:features:prod 立刻換成新的", async () => {
      const res = await call("setFeature", ["donate", { enabled: false }, "prod"], { put: async (k, v) => { kv.set(k, v); } });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(decodeSnapshot(kv.get("snap:features:prod")).data, { donate: { enabled: false } });
    });

    test("KV 寫不進去：動作照樣成功（資料已經存了），附警告叫人不要再按一次；下一個動作補寫", async () => {
      const res = await call("setFeature", ["donate", { enabled: false }, "prod"], { put: async () => { throw new Error("kv down"); } });
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.deepEqual(j.result, { data: { enabled: false } });
      assert.match(j.warning, /不要再按一次/);
      assert.match(j.warning, /npm run snapshots/);
      // 只讀的列表不會被擋住：照樣回結果，附「之前存的」那種警告
      const list = await call("listFeatures", ["prod"], { put: async () => { throw new Error("kv still down"); } });
      assert.equal(list.status, 200);
      assert.ok((await list.json()).result.rows);
      const ok = await call("listFeatures", ["prod"], { put: async (k, v) => { kv.set(k, v); } });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).warning, undefined);
      assert.ok(kv.has("snap:features:prod"), "下一個動作把上次沒寫成的補上");
    });

    test("動作沒改到資料（Neon 回 0 列）就不寫 KV", async () => {
      const realFetch2 = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const r = await realFetch2(url, init);
        const j = await r.json();
        return new Response(JSON.stringify({ ...j, rowCount: /^insert into features/.test(JSON.parse(init.body).query) ? 0 : (j.rows || []).length }), { status: 200 });
      };
      try {
        let puts = 0;
        const res = await call("setFeature", ["donate", { enabled: false }, "prod"], { put: async () => { puts++; } });
        assert.equal(res.status, 200);
        assert.equal(puts, 0);
      } finally { globalThis.fetch = realFetch2; }
    });
  });
});

describe("匿名統計：Analytics Engine 與每日彙總", () => {
  test("writePoint：沒有綁定或寫失敗都不丟錯", () => {
    const pts = [];
    assert.equal(writePoint({ TELEMETRY: { writeDataPoint: (p) => pts.push(p) } }, "trigger", "TW", "invite", "shown"), true);
    assert.deepEqual(pts[0], { blobs: ["trigger", "TW", "invite", "shown"], doubles: [1], indexes: ["TW"] });
    assert.equal(writePoint({}, "heartbeat", "TW"), false);
    assert.equal(writePoint({ TELEMETRY: { writeDataPoint: () => { throw new Error("x"); } } }, "heartbeat", "TW"), false);
  });

  test("查詢：心跳的範圍往前挪半格，每一格只屬於一天；其他是整天", () => {
    const q = rollupQueries("2026-11-18", "bb_telemetry");
    assert.match(q.heartbeat, /toDateTime\('2026-11-17 23:57:30'\) AND timestamp < toDateTime\('2026-11-18 23:57:30'\)/);
    assert.match(q.heartbeat, /SUM\(_sample_interval\)/);
    assert.match(q.blocked, /toDateTime\('2026-11-18 00:00:00'\) AND timestamp < toDateTime\('2026-11-19 00:00:00'\)/);
    assert.throws(() => rollupQueries("2026-11-18'; drop", "bb_telemetry"));
    assert.throws(() => rollupQueries("2026-11-18", "x; drop"));
  });

  const fakeAe = (byKind) => async (q) => byKind[/blob1 = '(\w+)'/.exec(q)[1]];
  test("寫回 Neon：覆蓋（n = excluded.n），濾掉不合格的列；重跑同一天結果一樣", async () => {
    const day = "2026-11-18", d0 = Date.parse(day + "T00:00:00Z") / 1000;
    const ae = fakeAe({
      heartbeat: [{ b: d0, country: "TW", n: "3" }, { b: d0 + 86400, country: "TW", n: 9 }, { b: d0 + 300, country: "bad", n: 1 }],
      blocked: [{ country: "SG", n: 2.4 }, { country: "SG'--", n: 1 }],
      trigger: [{ country: "TW", trigger: "invite", result: "cooldown", n: 5 }, { country: "TW", trigger: "x y", result: "shown", n: 1 }],
    });
    const writes = [];
    const q = async (sql, params) => { if (/^insert/.test(sql.trim())) writes.push({ sql, params }); return []; };
    const r = await rollupDay(day, { ae, q, dataset: "bb_telemetry" });
    assert.deepEqual(r, { day, heartbeat: 1, blocked: 1, trigger: 1 });
    assert.ok(writes.every((w) => /do update set n = excluded\.n/.test(w.sql)), "覆蓋，不是累加");
    assert.deepEqual(JSON.parse(writes[0].params[0]), [{ bucket: d0 * 1000, country: "TW", n: 3 }], "隔天 00:00 那格不算這一天");
    assert.deepEqual(writes[1].params, [day, JSON.stringify([{ country: "SG", n: 2 }])]);
    assert.deepEqual(JSON.parse(writes[2].params[1]), [{ country: "TW", trigger: "invite", result: "cooldown", n: 5 }]);
  });

  test("Analytics Engine 查詢失敗：什麼都不寫（不會用空結果蓋掉資料）", async () => {
    const writes = [];
    await assert.rejects(rollupDay("2026-11-18", { ae: async () => { throw new Error("analytics_engine_500"); }, q: async (s) => { writes.push(s); return []; }, dataset: "bb_telemetry" }));
    assert.deepEqual(writes, []);
  });

  test("Cron：彙總前天、昨天（UTC）；一天失敗不影響另一天；沒設定就不做", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(/'(\d{4}-\d{2}-\d{2}) 00:00:00'/.exec(init.body)?.[1]); if (init.body.includes("'2026-11-16 00:00:00'")) return new Response("boom", { status: 500 }); return new Response(JSON.stringify({ data: [] })); };
    const env = { CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t", TELEMETRY_DATASET: "bb_telemetry", DATABASE_URL: "x" };
    const out = await scheduledRollup(env, async () => [], Date.UTC(2026, 10, 18, 0, 20), fetchImpl);
    assert.equal(out.configured, true);
    assert.deepEqual(out.days.map((r) => r.day), ["2026-11-16", "2026-11-17"]);
    assert.ok(out.days[0].error && !out.days[1].error);
    const none = await scheduledRollup({ DATABASE_URL: "x" }, async () => [], NOW, fetchImpl);
    assert.deepEqual(none, { configured: false, missing: ["CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN", "TELEMETRY_DATASET"], days: [] }, "沒設定要說出來，不是默默回空的");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("Analytics Engine 結果被截斷（超過列數上限）：丟錯，不用少算的數字覆蓋", async () => {
    const ae = aeClient("a", "t", async () => new Response(JSON.stringify({ data: Array.from({ length: ROW_LIMIT }, () => ({ n: 1 })) })));
    await assert.rejects(ae("SELECT 1"), /truncated/);
    // rows_before_limit_at_least 跟實際列數對不上也不算截斷（staging 實測 6 列、它說 7）
    const ok = aeClient("a", "t", async () => new Response(JSON.stringify({ data: [{ n: 1 }], rows_before_limit_at_least: 7 })));
    assert.deepEqual(await ok("SELECT 1"), [{ n: 1 }]);
    for (const q of Object.values(rollupQueries("2026-11-18", "bb_telemetry"))) assert.match(q, new RegExp("LIMIT " + ROW_LIMIT + "$"));
  });
});

describe("每日 Cron：彙總、重建快照、留下紀錄", () => {
  const env = (over = {}) => ({ SNAPSHOT_ENV: "prod", CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t", TELEMETRY_DATASET: "bb_telemetry", DATABASE_URL: "x",
    RATE_KV: { get: async () => null, put: async (k, v) => { (over.puts || []).push(k); } }, ...over });
  const aeFetch = (rows) => async (url, init) => new Response(JSON.stringify({ data: /blob1 = 'heartbeat'/.test(init.body) ? rows : [] }));
  // 假 Neon：cron_runs 先 insert 一筆「開始了」（回 id），最後 update 成結果；比對前 7 天的 sum 回 sums
  const neon = (log, fail, sums = { y: 0, w: 0 }) => async (q, p) => {
    log.push(q.trim().split(/\s+/).slice(0, 3).join(" "));
    if (fail && fail.test(q)) throw new Error("neon_500 boom");
    if (/insert into cron_runs/.test(q)) { log.started = JSON.parse(p[0]); return [{ id: 7 }]; }
    if (/update cron_runs set ok/.test(q)) { log.record = { ok: p[0], detail: JSON.parse(p[1]), id: p[2] }; return []; }
    // 昨天（2026-11-17）那次查詢的起點是昨天；前 7 天那次的起點是 11-10
    if (/coalesce\(sum\(n\), 0\)/.test(q)) return [{ n: p[0] === "2026-11-17" || p[0] === Date.UTC(2026, 10, 17) ? sums.y : sums.w }];
    return [];
  };

  test("都成功：ok，全部快照重寫，記一筆 cron_runs；某天沒有心跳列成警告", async () => {
    _resetSnapshotMemory();
    const log = [], puts = [];
    const r = await runDaily(env({ puts }), neon(log), Date.UTC(2026, 10, 18, 0, 20), aeFetch([]));
    assert.equal(r.ok, true);
    assert.deepEqual(puts.sort(), ["snap:announcements:prod", "snap:features:prod", "snap:lotteries:prod", "snap:surveys:prod"]);
    assert.equal(log.record.ok, true);
    assert.deepEqual(log.started, { running: true }, "先記一筆「開始了」：中途被終止時後台看得到");
    assert.equal(log.record.id, 7, "最後更新同一筆");
    assert.deepEqual(log.record.detail.warnings, ["2026-11-16 沒有任何播放心跳", "2026-11-17 沒有任何播放心跳"]);
  });

  test("昨天比前 7 天平均少一半以上：警告（Analytics Engine 額度用完時數字會默默變少）", async () => {
    _resetSnapshotMemory();
    const log = [];
    const r = await runDaily(env(), neon(log, null, { y: 50, w: 1400 }), Date.UTC(2026, 10, 18, 0, 20), aeFetch([]));
    assert.equal(r.ok, true, "警告不算失敗");
    assert.ok(log.record.detail.warnings.some((w) => /2026-11-17 的播放心跳只有 50，前 7 天平均 200/.test(w)), log.record.detail.warnings.join(" | "));
    // 量太小（平均不到 100）不比
    const log2 = [];
    await runDaily(env(), neon(log2, null, { y: 0, w: 70 }), Date.UTC(2026, 10, 18, 0, 20), aeFetch([]));
    assert.ok(!log2.record.detail.warnings.some((w) => /少一半/.test(w)));
  });

  test("快照原本有資料、重建後是空的：照寫，但列成警告", async () => {
    _resetSnapshotMemory();
    const log = [];
    const kvEnv = env({ RATE_KV: {
      get: async (k) => (k === "snap:surveys:prod" ? encodeSnapshot([{ id: "a" }, { id: "b" }]) : null),
      put: async () => {},
    } });
    const r = await runDaily(kvEnv, neon(log), NOW, aeFetch([]));
    assert.equal(r.snapshots.surveys, "ok_emptied:2");
    assert.equal(r.ok, true);
    assert.ok(log.record.detail.warnings.some((w) => /快照 surveys 原本有 2 筆，重建後是空的/.test(w)));
  });

  test("部署時記一筆 deployed（Cron 從沒觸發時後台才知道要標紅）", async () => {
    const seen = [];
    await markDeployed(async (q, p) => { seen.push([q.trim().split(/\s+/).slice(0, 3).join(" "), p]); return []; });
    assert.deepEqual(seen.map((x) => x[0]), ["create table if", "insert into cron_runs"]);
  });

  test("統計沒設定、快照重建失敗：ok = false，原因寫進紀錄（無人值守，不能默默略過）", async () => {
    _resetSnapshotMemory();
    const log = [];
    const r = await runDaily(env({ CF_ANALYTICS_TOKEN: "" }), neon(log, /from features/), NOW, aeFetch([]));
    assert.equal(r.ok, false);
    assert.equal(log.record.ok, false);
    assert.match(log.record.detail.warnings[0], /沒有設定：CF_ANALYTICS_TOKEN/);
    assert.match(log.record.detail.snapshots.features, /^error: .*boom/);
    assert.equal(log.record.detail.snapshots.lotteries, "ok");
  });

  test("refreshAllSnapshots：表不存在的那份不寫（不把空的寫進 KV）", async () => {
    _resetSnapshotMemory();
    const puts = [];
    const out = await refreshAllSnapshots(env({ puts }), async (q) => { if (/from surveys/.test(q)) throw relErrDaily("surveys"); return []; }, NOW);
    assert.equal(out.surveys, "skipped_missing_table");
    assert.ok(!puts.includes("snap:surveys:prod"));
  });
  const relErrDaily = (t) => new Error(`neon_400 {"message":"relation \\"${t}\\" does not exist","code":"42P01"}`);
});

describe("快照寫入端：同時性與 CLI 結束", () => {
  test("同時兩個 flush 排隊執行：後面那個等前面寫完；前面失敗時後面會把標記再寫一次", async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const sqlFor = (db) => async (name) => ({ name, db });
    markWrite("prod", "update announcements set title = $1");
    const a = flushSnapshots(async () => { order.push("A start"); await gate; order.push("A fail"); throw new Error("kv down"); }, { sqlFor });
    markWrite("prod", "update features set data = $1");
    const b = flushSnapshots(async (entries) => { order.push("B " + entries.map((e) => e.key).sort().join(",")); }, { sqlFor });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["A start"], "B 還在排隊");
    release();
    await assert.rejects(a, /kv down/);
    await b;
    assert.deepEqual(order, ["A start", "A fail", "B snap:announcements:prod,snap:features:prod"], "A 沒寫成的，B 一起寫");
  });

  const KV_MOD = JSON.stringify(new URL("../scripts/lib/kv-snapshot.mjs", import.meta.url).href);
  const runChild = (body) => spawnSync(process.execPath, ["--input-type=module", "-e", body], { encoding: "utf8", timeout: 20_000 });

  test("CLI：寫 KV 失敗只試一次（writer 真的被叫一次），印警告、exitCode 1 後結束（不會無限重試）", () => {
    const r = runChild(`
      import { markWrite, useExitFlush } from ${KV_MOD};
      let tries = 0;
      useExitFlush(async () => { tries++; throw new Error("wrangler 沒登入"); }, { sqlFor: () => async () => ({}) });
      markWrite("staging", "update features set data = $1");
      process.on("exit", () => console.log("TRIES=" + tries));`);
    assert.notEqual(r.signal, "SIGTERM", "程式要自己結束，不能卡住");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /TRIES=1\b/);
    assert.equal((r.stderr.match(/KV 快照沒更新/g) || []).length, 1, "警告只印一次");
  });

  test("CLI：寫成功時印「已更新」、exit 0；有表不存在的那份不寫並提醒", () => {
    const r = runChild(`
      import { markWrite, useExitFlush } from ${KV_MOD};
      const wrote = [];
      useExitFlush(async (e) => { wrote.push(...e.map((x) => x.key)); }, { sqlFor: () => async (name, info) => { if (name === "surveys") info.missing = true; return name === "surveys" ? [] : {}; } });
      markWrite("staging", "update features set data = $1");
      markWrite("staging", "update surveys set status = 'x'");
      process.on("exit", () => console.log("WROTE=" + wrote.join(",")));`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /WROTE=snap:features:staging$/m);
    assert.match(r.stderr, /已更新 KV 快照（staging：features）/);
    assert.match(r.stderr, /這些快照沒寫：.*staging：surveys/);
  });

  test("CLI：程式因為沒接住的錯誤結束時，至少印出 KV 沒更新的警告", () => {
    const r = runChild(`
      import { markWrite, useExitFlush } from ${KV_MOD};
      useExitFlush(async () => {}, { sqlFor: () => async () => ({}) });
      markWrite("prod", "update announcements set title = $1");
      throw new Error("Neon 503");`);
    assert.notEqual(r.status, 0);
    assert.equal((r.stderr.match(/KV 快照沒更新（prod：announcements）：程式出錯中斷/g) || []).length, 1, r.stderr);
  });

  test("後台看今天、昨天：直接查 Analytics Engine", async () => {
    let sent;
    const rows = await recentTriggers(async (q) => { sent = q; return [{ d: Date.UTC(2026, 10, 18) / 1000, trigger: "invite", result: "shown", n: "4" }]; }, "bb_telemetry_staging", NOW);
    assert.deepEqual(rows, [{ day: "2026-11-18", trigger: "invite", result: "shown", n: 4 }]);
    assert.match(sent, /FROM bb_telemetry_staging/);
    assert.match(sent, /2026-11-17 00:00:00/);
  });
});
