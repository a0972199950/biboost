// 公告改版（2026-11-21）：後台手動新增三種公告（一般／抽獎／問卷）、公告自己的期間、抽獎不再自動建公告。
// 資料庫用假的 Neon（攔 fetch），只看送出的 SQL 與參數。
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://ep-prod.ap-southeast-1.aws.neon.tech/db";
process.env.DATABASE_URL_STAGING = "postgres://ep-staging.ap-southeast-1.aws.neon.tech/db";
const A = await import("../scripts/lib/announcements.mjs");
const V = await import("../scripts/lib/lotteries-v2.mjs");
const L = await import("../scripts/lib/lotteries.mjs");

let log, answer;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init) => {
    const { query, params } = JSON.parse(init.body);
    const host = new URL(init.headers["Neon-Connection-String"]).hostname;
    log.push({ host, query: query.replace(/\s+/g, " ").trim(), params });
    const rows = answer(query, params) || [];
    return new Response(JSON.stringify({ rows, rowCount: rows.length || 1 }), { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { log = []; answer = () => []; });

const T0 = Date.UTC(2026, 10, 21, 0, 0, 0);
const base = { title: { "zh-TW": "標題" }, countries: ["sg", "SG"] };

describe("validateAnnouncement", () => {
  test("沒給 type 當作一般公告；一般公告要有內文，期間可空", () => {
    const a = A.validateAnnouncement({ ...base, html: { en: " <p>x</p> " } });
    assert.equal(a.type, "html");
    assert.deepEqual(a.countries, ["SG"]);
    assert.deepEqual([a.startsAt, a.endsAt, a.lotteryId, a.surveyId], [null, null, null, null]);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "html" }), /內容/);
  });
  test("抽獎、問卷公告：沒有內文，一定要選對象、要有開始時間；結束要晚於開始", () => {
    const l = A.validateAnnouncement({ ...base, type: "lottery", lotteryId: "6", startsAt: T0, html: { en: "ignored" } });
    assert.deepEqual([l.lotteryId, l.html, l.startsAt], [6, null, T0]);
    const s = A.validateAnnouncement({ ...base, type: "survey", surveyId: "sample-survey", startsAt: new Date(T0).toISOString(), endsAt: null });
    assert.deepEqual([s.surveyId, s.startsAt, s.endsAt], ["sample-survey", T0, null]);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "lottery", startsAt: T0 }), /抽獎/);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "survey", surveyId: "Bad ID", startsAt: T0 }), /問卷/);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "survey", surveyId: "ok-id" }), /開始時間/);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "survey", surveyId: "ok-id", startsAt: T0, endsAt: T0 }), /晚於/);
    assert.throws(() => A.validateAnnouncement({ ...base, type: "weird" }), /類型/);
    assert.throws(() => A.validateAnnouncement({ type: "html", html: { en: "x" }, title: { xx: "t" } }), /標題/);
    assert.throws(() => A.validateAnnouncement({ ...base, html: { en: "x" }, startsAt: "not a date" }), /時間格式/);
  });
});

describe("寫入", () => {
  test("新增問卷公告：先升級 schema（加欄位、type 加 survey），確認問卷存在，再 insert", async () => {
    answer = (q) => {
      if (/to_regclass\('public\.surveys'\)/.test(q)) return [{ t: "surveys" }];
      if (/select id from surveys where id/.test(q)) return [{ id: "sample-survey" }];
      if (/^insert into announcements/.test(q.trim())) return [{ id: 11 }];
      return [];
    };
    const id = await L.withDb("staging", () => A.addAnnouncement({ ...base, type: "survey", surveyId: "sample-survey", startsAt: T0 }));
    assert.equal(id, 11);
    assert.ok(log.every((x) => x.host.startsWith("ep-staging")), "withDb(staging) 打測試環境");
    const qs = log.map((x) => x.query);
    assert.ok(qs.some((q) => /add column if not exists survey_id text/.test(q)));
    assert.ok(qs.some((q) => /check \(type in \('lottery', 'html', 'survey'\)\)/.test(q)));
    const ins = log.find((x) => /^insert into announcements/.test(x.query));
    assert.deepEqual(ins.params, ["survey", null, JSON.stringify({ "zh-TW": "標題" }), null, ["SG"], null, "sample-survey", new Date(T0).toISOString(), null]);
  });
  test("抽獎公告：抽獎要存在；同一個抽獎已經有公告就擋下（給人看的訊息）", async () => {
    answer = (q) => {
      if (/select id from lotteries_v2 where id/.test(q)) return [{ id: 6 }];
      if (/select id from announcements where lottery_v2_id/.test(q)) return [{ id: 3 }];
      return [];
    };
    await assert.rejects(L.withDb("staging", () => A.addAnnouncement({ ...base, type: "lottery", lotteryId: 6, startsAt: T0 })), /已經有公告（第 3 則）/);
    answer = () => [];
    await assert.rejects(L.withDb("staging", () => A.addAnnouncement({ ...base, type: "lottery", lotteryId: 6, startsAt: T0 })), /測試環境沒有抽獎 #6/);
  });
  test("新增抽獎（v1、v2）不再自動建公告；建表也不再替 v1 抽獎補建公告", async () => {
    answer = (q) => (/^insert into lotteries/.test(q.trim()) ? [{ id: 7 }] : []);
    const meta = { title: { en: "T" }, country: "SG", start: "2026-11-01", end: "2026-11-30", currency: "SGD", giftCards: [{ name: "A", amount: 10 }], note: {}, winners: 1, isps: [], drawDays: 7 };
    // 用正式環境的假資料庫：這個檔案裡第一次建表，建表的 SQL 也一起檢查
    assert.equal(await L.withDb("prod", () => V.addLotteryV2(meta)), 7);
    assert.ok(log.some((x) => /create table if not exists announcements/.test(x.query)), "有跑到建表");
    await L.withDb("prod", () => L.addLottery({ title: "T", country: "SG", start: "2026-11-01", end: "2026-11-30", prize: { amount: 10, currency: "SGD", giftCards: ["A"] }, winners: 1, isps: [], drawDays: 7 }));
    const writes = log.map((x) => x.query).filter((q) => /insert into announcements/.test(q));
    assert.deepEqual(writes, []);
  });
  test("刪除不限類型（抽獎公告也能刪）", async () => {
    answer = (q) => (/to_regclass\('public\.announcements'\)/.test(q) ? [{ t: "announcements" }] : /^delete from announcements/.test(q.trim()) ? [{ id: 4 }] : [{ column_name: "starts_at" }]);
    assert.equal(await L.withDb("staging", () => A.deleteAnnouncement(4)), true);
    const del = log.find((x) => /^delete from announcements/.test(x.query));
    assert.ok(!/type = 'html'/.test(del.query));
  });
  test("不能跨環境：連結的抽獎／問卷只在同一個環境的資料庫找（正式有、測試沒有 → 測試的公告存不進去）", async () => {
    // 假資料庫：正式環境有抽獎 #12、問卷 prod-only；測試環境都沒有
    answer = (q, p) => {
      const host = log[log.length - 1].host;
      const prod = host.startsWith("ep-prod");
      if (/select id from lotteries_v2 where id/.test(q)) return prod && p[0] === 12 ? [{ id: 12 }] : [];
      if (/to_regclass\('public\.surveys'\)/.test(q)) return [{ t: "surveys" }];
      if (/select id from surveys where id/.test(q)) return prod && p[0] === "prod-only" ? [{ id: "prod-only" }] : [];
      if (/^insert into announcements/.test(q.trim())) return [{ id: 99 }];
      if (/^update announcements/.test(q.trim())) return [{ id: 5 }];
      return [];
    };
    const lot = { ...base, type: "lottery", lotteryId: 12, startsAt: T0 };
    const sur = { ...base, type: "survey", surveyId: "prod-only", startsAt: T0 };
    await assert.rejects(L.withDb("staging", () => A.addAnnouncement(lot)), (e) => e instanceof A.AnnouncementError && /^測試環境沒有抽獎 #12/.test(e.message));
    await assert.rejects(L.withDb("staging", () => A.updateAnnouncement(5, lot)), /測試環境沒有抽獎 #12/, "編輯也擋");
    await assert.rejects(L.withDb("staging", () => A.addAnnouncement(sur)), /測試環境沒有問卷「prod-only」/);
    assert.ok(!log.some((x) => x.host.startsWith("ep-prod")), "測試環境的公告完全沒查正式資料庫");
    assert.ok(!log.some((x) => /^(insert|update) announcements/.test(x.query)), "沒有寫進去");
    log = [];
    assert.equal(await L.withDb("prod", () => A.addAnnouncement(lot)), 99, "正式環境有 #12，正式的公告可以連");
    assert.equal(await L.withDb("prod", () => A.addAnnouncement(sur)), 99);
    assert.ok(log.every((x) => x.host.startsWith("ep-prod")));
    // 反過來：正式環境沒有的（只在測試環境）也擋
    answer = (q) => (/select id from lotteries_v2 where id/.test(q) ? [] : /to_regclass/.test(q) ? [{ t: "surveys" }] : []);
    await assert.rejects(L.withDb("prod", () => A.addAnnouncement({ ...lot, lotteryId: 6 })), /正式環境沒有抽獎 #6/);
  });
  test("後台 API：saveAnnouncement 照 env 切資料庫，跨環境的錯誤原樣回給畫面", async () => {
    const { handleAdminApi } = await import("../scripts/lib/admin-api.mjs");
    const { makeSession } = await import("../scripts/lib/admin-auth.mjs");
    const KEY = "k".repeat(40);
    const ctx = { local: false, ip: "1", limiter: { get: async () => 0, incr: async () => {} }, env: { ADMIN_USER: "u", ADMIN_PASS_HASH: "x", ADMIN_SESSION_KEY: KEY, RATE_KV: { put: async () => {} } } };
    const req = async (args) => new Request("https://biboost.app/admin/api/saveAnnouncement", {
      method: "POST", body: JSON.stringify({ args }),
      headers: { "Content-Type": "application/json", "X-BB-Admin": "1", Origin: "https://biboost.app", Cookie: `__Host-bb_admin=${await makeSession(KEY)}` },
    });
    answer = () => [];
    const res = await handleAdminApi(await req([null, { ...base, type: "lottery", lotteryId: 12, startsAt: T0 }, "staging"]), ctx);
    const j = await res.json();
    assert.equal(res.status, 400);
    assert.match(j.error, /^測試環境沒有抽獎 #12/);
    // （之後重寫 KV 快照的查詢不算：前面測試留下的正式環境標記也會在這次一起寫）
    const look = log.filter((x) => /from lotteries_v2 where id/.test(x.query) ||/^(insert|update) announcements/.test(x.query));
    assert.ok(look.length && look.every((x) => x.host.startsWith("ep-staging")), JSON.stringify(look));
    assert.ok(!log.some((x) => /^(insert|update) announcements/.test(x.query)));
  });
});

describe("讀取", () => {
  test("看列表不改 schema；改版的欄位還沒加時當作空的（正式環境上線前）", async () => {
    answer = (q) => (/to_regclass/.test(q) ? [{ t: "announcements" }] : []);
    assert.deepEqual(await A.listAnnouncements(), []);
    const qs = log.map((x) => x.query);
    assert.ok(!qs.some((q) => /alter table|create table|insert into|do \$\$/.test(q)), qs.join("\n"));
    const list = qs.find((q) => /from announcements a left join/.test(q));
    assert.ok(/null::text as survey_id/.test(list) && !/a\.starts_at/.test(list));
  });
  test("列表：類型、連結的對象、期間、新版擴充會不會顯示", async () => {
    const now = Date.now();
    const rows = [
      { id: 1, type: "lottery", lottery_v2_id: 6, title: null, prefix: null, countries: null, starts_ms: null, ends_ms: null, lottery_status: "active", lottery_country: "SG", lottery_v2_title: { en: "Draw" } },
      { id: 2, type: "lottery", lottery_v2_id: 5, title: { en: "Mine" }, countries: ["HK"], starts_ms: now - 10, ends_ms: null, lottery_status: "ended" },
      { id: 3, type: "survey", survey_id: "sample-survey", title: { en: "S" }, starts_ms: now + 1e6, ends_ms: null },
      { id: 4, type: "html", title: { en: "H" }, starts_ms: null, ends_ms: now - 1 },
    ];
    answer = (q) => {
      if (/to_regclass\('public\.announcements'\)/.test(q)) return [{ t: "announcements" }];
      if (/to_regclass\('public\.surveys'\)/.test(q)) return [{ t: null }];
      if (/information_schema/.test(q)) return ["survey_id", "starts_at", "ends_at", "lottery_v2_id"].map((c) => ({ column_name: c }));
      if (/from announcements a left join/.test(q)) return rows;
      return [];
    };
    const out = await A.listAnnouncements();
    assert.deepEqual(out.map((a) => [a.id, a.visible, a.period]), [[1, true, "active"], [2, true, "active"], [3, false, "upcoming"], [4, false, "ended"]]);
    assert.equal(out[0].legacy, true);
    assert.deepEqual(out[0].countries, ["SG"], "改版前的抽獎公告：國家是抽獎的");
    assert.deepEqual(out[0].title, { en: "Draw" });
    assert.equal(out[1].targetEnded, true, "抽獎結束了，公告照樣顯示（點開說已經結束）");
    assert.equal(out[2].surveyState, "missing");
  });
});
