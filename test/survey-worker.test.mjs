// report worker 的問卷與匿名統計 API（tools/report-worker/src/surveys.js）。資料庫換成記憶體版本；SQL 本身在 staging 實測。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleSurveys, listFor, extOriginOk, isSurveyPath, surveyStore } from "../tools/report-worker/src/surveys.js";
import { _resetSnapshotMemory, encodeSnapshot } from "../tools/report-worker/src/snapshots.js";
import { sampleDef } from "./helpers/survey-sample.mjs";

const STORE_IDS = { dfaddcffoondcendifiljhdbdagebgch: "chrome", dllallgilijcacpdemjafegibdafcbdp: "edge" };
const CHROME = "chrome-extension://dfaddcffoondcendifiljhdbdagebgch";
const CLIENT = { browser: "chrome", ext_version: "2.11.0", lang: "en", install_days: "7_30", custom_nodes: false };
const RID = "0123456789abcdef0123456789abcdef";

function memStore(surveys) {
  const m = { surveys, responses: {}, counted: [], events: [], triggers: {}, heartbeats: {}, blockedDays: {} };
  m.activeSurveys = async () => m.surveys.filter((s) => !s.ended).map((s) => ({ id: s.id, def: s.def, startsAt: s.startsAt ?? null, endsAt: s.endsAt ?? null }));
  m.publishedSurvey = async (id) => { const s = m.surveys.find((x) => x.id === id); return s ? { def: s.def, ended: !!s.ended } : null; };
  m.response = async (rid) => (m.responses[rid] ? { survey_id: m.responses[rid].survey_id, completed: m.responses[rid].completed } : null);
  m.saveResponse = async (r) => { const p = m.responses[r.response_id]; m.responses[r.response_id] = { ...r, completed: Math.max(r.completed, p ? p.completed : 0), after_end: Math.max(r.after_end, p ? p.after_end : 0) }; };
  m.countCompleted = async (id) => { m.counted.push(id); return { justEnded: false }; };
  m.addEvent = async (e) => { m.events.push(e); };
  m.bumpTrigger = async (c, t, r) => { const k = [c, t, r].join("|"); m.triggers[k] = (m.triggers[k] || 0) + 1; };
  m.heartbeat = async (c) => { m.heartbeats[c] = (m.heartbeats[c] || 0) + 1; };
  m.blocked = async (c) => { m.blockedDays[c] = (m.blockedDays[c] || 0) + 1; };
  return m;
}
const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (status, error) => json(status, { ok: false, error });
function call(store, { method = "POST", path, body, origin = CHROME, country = "US", env = {}, query = "", neonSql, ctx = { waitUntil() {} } }) {
  const url = new URL(`https://api.biboost.app${path}${query}`);
  const headers = { "CF-IPCountry": country, "CF-Connecting-IP": "1.2.3.4" };
  if (origin) headers.Origin = origin;
  const req = new Request(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  return handleSurveys(req, env, ctx, url, { json, fail, CORS, storeIds: STORE_IDS, store, neonSql, now: () => Date.UTC(2026, 10, 18, 3, 2, 0) });
}
const answer = (over = {}) => ({ survey_id: "sample-survey", response_id: RID, answers: { q_fruit: ["apple"], q_often: "never", q_rate: 5 }, final: false, entry: "invite", client: CLIENT, ...over });

describe("report worker：問卷清單", () => {
  test("依國家套好變體；中國大陸回空清單；對象與擴充版本不符的不給", async () => {
    const other = { ...sampleDef(), id: "tw-only", audience: { countries: ["TW"], langs: [] } };
    const store = memStore([{ id: "sample-survey", def: sampleDef() }, { id: "tw-only", def: other }]);
    const us = await (await call(store, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.11.0" })).json();
    assert.deepEqual(us.surveys.map((s) => s.id), ["sample-survey"]);
    const tw = await (await call(store, { method: "GET", path: "/v2/surveys", country: "TW", query: "?lang=zh_TW&v=2.11.0" })).json();
    assert.deepEqual(tw.surveys.map((s) => s.id), ["sample-survey", "tw-only"]);
    assert.equal(tw.surveys[0].questions[2].text.en, "often (TW)?");
    const cn = await (await call(store, { method: "GET", path: "/v2/surveys", country: "CN", query: "?lang=zh_CN&v=2.11.0" })).json();
    assert.deepEqual(cn.surveys, []);
    const old = await (await call(store, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.9.0" })).json();
    assert.deepEqual(old.surveys, [], "比問卷要求的版本舊的擴充拿不到");
  });
  test("listFor：版本比較與語言過濾", () => {
    const rows = [{ id: "a", def: { ...sampleDef(), audience: { countries: [], langs: ["ja"] } } }];
    assert.equal(listFor(rows, "JP", "ja", "2.11.0").length, 1);
    assert.equal(listFor(rows, "JP", "en", "2.11.0").length, 0);
  });
});

describe("report worker：作答", () => {
  test("只收擴充的 Origin：正式環境限商店版的 Chrome／Edge id；Firefox、Safari 看開頭；測試環境收所有擴充", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: "https://evil.example" })).status, 403);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: null })).status, 403);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).status, 403, "開發版的 id");
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", env: { SURVEY_ANY_EXTENSION: "1" } })).status, 200);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: "moz-extension://1b2c3d4e-0000-1111-2222-333344445555" })).status, 200);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), origin: "safari-web-extension://ABCD-1234" })).status, 200);
    assert.equal(extOriginOk(new Request("https://x/", { headers: { Origin: CHROME } }), {}, STORE_IDS), true);
  });
  test("存作答；送出完成只計一次份數；問卷結束後照收並標 after_end", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer() })).status, 200);
    assert.equal(store.responses[RID].completed, 0);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ final: true }) })).status, 200);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ final: true }) })).status, 200);
    assert.deepEqual(store.counted, ["sample-survey"], "同一份重送不重複計");
    assert.equal(store.responses[RID].after_end, 0);
    store.surveys[0].ended = true;
    const rid2 = "f".repeat(32);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ response_id: rid2 }) })).status, 200);
    assert.equal(store.responses[rid2].after_end, 1);
  });
  test("已經完成的那筆（公告重填）：草稿不覆蓋完整答案，再送一次完成才覆蓋；份數只在第一次完成時加一", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    await call(store, { path: "/v2/surveys/responses", body: answer({ final: true }) });
    const first = JSON.stringify(store.responses[RID].answers);
    // 重填答到一半（草稿）：回 ok，但不寫
    const draft = await call(store, { path: "/v2/surveys/responses", body: answer({ answers: { q_fruit: ["pear"] } }) });
    assert.equal(draft.status, 200);
    assert.equal(JSON.stringify(store.responses[RID].answers), first, "草稿不動已完成的答案");
    assert.equal(store.responses[RID].completed, 1);
    // 重填送出：覆蓋成最新的答案
    const again = { q_fruit: ["pear"], q_often: "never", q_rate: 2 };
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ final: true, answers: again }) })).status, 200);
    assert.deepEqual(store.responses[RID].answers, again);
    assert.deepEqual(store.counted, ["sample-survey"], "重填不再加份數");
  });
  test("saveResponse 的 SQL：已完成的那筆收到草稿時，答案、Email、updated_at 保留原值（資料庫端的同一條保護）", async () => {
    const seen = [];
    const s = surveyStore({}, async (env, sql, params) => { seen.push({ sql, params }); return []; });
    await s.saveResponse({ response_id: RID, survey_id: "sample-survey", answers: {}, email: null, country: "US", entry: "invite", browser: "chrome", ext_version: "2.11.0", lang: "en", install_days: "7_30", custom_nodes: false, completed: 0, after_end: 0, at: 1 });
    const sql = seen[0].sql.replace(/\s+/g, " ");
    for (const col of ["answers", "email", "updated_at"]) {
      assert.match(sql, new RegExp(`${col} = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.${col} else excluded.${col} end`), col);
    }
    assert.match(sql, /completed_at = coalesce\(survey_responses.completed_at, excluded.completed_at\)/, "completed_at 留第一次完成");
  });
  test("沒發布的問卷 404；response_id 屬於別份問卷 409；格式錯誤 400；中國大陸 404", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }, { id: "other-survey", def: { ...sampleDef(), id: "other-survey" } }]);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ survey_id: "missing-survey" }) })).status, 404);
    await call(store, { path: "/v2/surveys/responses", body: answer() });
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ survey_id: "other-survey" }) })).status, 409);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ response_id: "xyz" }) })).status, 400);
    const r = await call(store, { path: "/v2/surveys/responses", body: answer({ answers: { q_often: "sometimes" } }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "bad_answer");
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ entry: "context" }) })).status, 400);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), country: "CN" })).status, 404);
  });
  test("流程圖：只存路徑上的答案（換路後舊路上的答案丟掉）；走到結束之後的必答題不要求", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    const r = await call(store, { path: "/v2/surveys/responses", body: answer({ answers: { q_fruit: ["apple"], q_often: "never", q_rate: 5, q_why: "taste", q_size: "p1" } }) });
    assert.equal(r.status, 200);
    assert.deepEqual(store.responses[RID].answers, { q_fruit: ["apple"], q_often: "never", q_rate: 5 });
    const jp = await call(store, { path: "/v2/surveys/responses", country: "JP", body: answer({ final: true, answers: { q_fruit: ["pear"], q_often: "daily", q_size: "y3" } }) });
    assert.equal(jp.status, 200, "日本版選 y3 直接結束");
    assert.deepEqual(store.responses[RID].answers, { q_fruit: ["pear"], q_often: "daily", q_size: "y3" });
  });
  test("流程圖壞掉的問卷（指回前面、走不到、還是舊的 showIf）：清單不下發、作答回 409", async () => {
    const loop = sampleDef();
    loop.questions[4].next = { else: "q_often" };
    const legacy = sampleDef();
    legacy.questions[4].showIf = { q: "q_often", in: ["weekly"] };
    const store = memStore([{ id: "sample-survey", def: loop }, { id: "legacy-survey", def: { ...legacy, id: "legacy-survey" } }]);
    const origErr = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a.join(" "));
    try {
      const list = await (await call(store, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.11.0" })).json();
      assert.deepEqual(list.surveys, []);
      const r = await call(store, { path: "/v2/surveys/responses", body: answer() });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, "bad_definition");
    } finally { console.error = origErr; }
    assert.ok(logged.some((x) => /survey flow sample-survey/.test(x)), "wrangler tail 看得到是哪一份");
  });
  test("限流：超過時回 429（送出完成另外一組限制）", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    const deny = { limit: async () => ({ success: false }) }, allow = { limit: async () => ({ success: true }) };
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), env: { SURVEY_RL: deny } })).status, 429);
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), env: { SURVEY_RL: allow, SURVEY_DONE_RL: deny } })).status, 200, "沒送出的不受送出限制");
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer({ final: true }), env: { SURVEY_RL: allow, SURVEY_DONE_RL: deny } })).status, 429);
    const broken = { limit: async () => { throw new Error("down"); } };
    assert.equal((await call(store, { path: "/v2/surveys/responses", body: answer(), env: { SURVEY_RL: broken } })).status, 200, "限流服務出錯時不擋人");
  });
});

describe("report worker：事件、觸發機會、匿名統計", () => {
  test("事件：shown／page／closed／completed，數字超出範圍的存 null", async () => {
    const store = memStore([{ id: "sample-survey", def: sampleDef() }]);
    const ev = (o) => ({ survey_id: "sample-survey", response_id: RID, entry: "region_blocked", client: CLIENT, ...o });
    assert.equal((await call(store, { path: "/v2/surveys/events", body: ev({ kind: "page", page: 2, question: "q_often", ms: 4200 }) })).status, 204);
    assert.equal((await call(store, { path: "/v2/surveys/events", body: ev({ kind: "closed", page: 999, ms: -1 }) })).status, 204);
    assert.equal((await call(store, { path: "/v2/surveys/events", body: ev({ kind: "hover" }) })).status, 400);
    assert.deepEqual(store.events.map((e) => [e.kind, e.page, e.question, e.ms, e.entry, e.country]), [["page", 2, "q_often", 4200, "region_blocked", "US"], ["closed", null, null, null, "region_blocked", "US"]]);
  });
  test("觸發機會：國家 × 觸發方式 × 結果", async () => {
    const store = memStore([]);
    assert.equal((await call(store, { path: "/v2/surveys/triggers", body: { trigger: "invite", result: "cooldown" } })).status, 204);
    assert.equal((await call(store, { path: "/v2/surveys/triggers", body: { trigger: "invite", result: "cooldown" } })).status, 204);
    assert.equal((await call(store, { path: "/v2/surveys/triggers", body: { trigger: "click", result: "shown" } })).status, 400);
    assert.deepEqual(store.triggers, { "US|invite|cooldown": 2 });
  });
  test("播放心跳與遇到地區限定；一樣只收擴充的 Origin", async () => {
    const store = memStore([]);
    assert.equal((await call(store, { path: "/v1/telemetry/heartbeat" })).status, 204);
    assert.equal((await call(store, { path: "/v1/telemetry/blocked", country: "SG" })).status, 204);
    assert.equal((await call(store, { path: "/v1/telemetry/blocked", origin: "https://evil.example" })).status, 403);
    assert.deepEqual(store.heartbeats, { US: 1 });
    assert.deepEqual(store.blockedDays, { SG: 1 });
  });
  test("路徑清單", () => {
    assert.equal(isSurveyPath("/v2/surveys"), true);
    assert.equal(isSurveyPath("/v1/survey"), false, "舊的單問卷路徑不再支援");
  });
});

// 用真的 surveyStore（KV 快照 ＋ Analytics Engine），資料庫換成會記錄每一次查詢的假 Neon：確認全天都有人打的請求不碰 Neon
describe("report worker：不讓 Neon 一直醒著", () => {
  const NOW = Date.UTC(2026, 10, 18, 3, 2, 0);
  function fakeEnv({ snapshot } = {}) {
    const kv = new Map(), points = [], neon = [];
    if (snapshot) kv.set("snap:surveys:prod", encodeSnapshot(snapshot));
    const env = {
      SNAPSHOT_ENV: "prod",
      RATE_KV: { get: async (k, o) => { const v = kv.get(k); return v == null ? null : o && o.type === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); } },
      TELEMETRY: { writeDataPoint: (p) => points.push(p) },
    };
    return { env, kv, points, neon };
  }
  const neonFor = (box, rows) => async (env, q, p) => { box.neon.push(q); return typeof rows === "function" ? rows(q, p) : rows; };

  test("心跳、地區限定、觸發機會只寫 Analytics Engine", async () => {
    _resetSnapshotMemory();
    const box = fakeEnv();
    const neonSql = neonFor(box, []);
    assert.equal((await call(null, { path: "/v1/telemetry/heartbeat", env: box.env, neonSql })).status, 204);
    assert.equal((await call(null, { path: "/v1/telemetry/blocked", country: "SG", env: box.env, neonSql })).status, 204);
    assert.equal((await call(null, { path: "/v2/surveys/triggers", body: { trigger: "invite", result: "cooldown" }, env: box.env, neonSql })).status, 204);
    assert.deepEqual(box.neon, [], "不碰 Neon");
    assert.deepEqual(box.points.map((p) => [p.blobs, p.doubles, p.indexes]), [
      [["heartbeat", "US", "", ""], [1], ["US"]],
      [["blocked", "SG", "", ""], [1], ["SG"]],
      [["trigger", "US", "invite", "cooldown"], [1], ["US"]],
    ]);
  });

  test("問卷清單讀 KV 快照，期間用現在時間判斷；不碰 Neon", async () => {
    _resetSnapshotMemory();
    const later = { ...sampleDef(), id: "later" }, over = { ...sampleDef(), id: "over" };
    const box = fakeEnv({ snapshot: [
      { id: "sample-survey", def: sampleDef(), startsAt: NOW - 1000, endsAt: null },
      { id: "later", def: later, startsAt: NOW + 3600_000, endsAt: null },
      { id: "over", def: over, startsAt: null, endsAt: NOW - 1 },
    ] });
    const r = await (await call(null, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.11.0", env: box.env, neonSql: neonFor(box, []) })).json();
    assert.deepEqual(r.surveys.map((s) => s.id), ["sample-survey"], "還沒開始、已經到期的不給");
    assert.deepEqual(box.neon, []);
  });

  test("KV 沒有快照：查 Neon 一次、寫回 KV；同一個 isolate 接下來不再查", async () => {
    _resetSnapshotMemory();
    const box = fakeEnv();
    const neonSql = neonFor(box, (q) => (/from surveys/.test(q) ? [{ id: "sample-survey", def: sampleDef(), starts_ms: null, ends_ms: null }] : []));
    for (let i = 0; i < 3; i++) {
      const r = await (await call(null, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.11.0", env: box.env, neonSql })).json();
      assert.deepEqual(r.surveys.map((s) => s.id), ["sample-survey"]);
    }
    assert.equal(box.neon.length, 1, "只退回查一次");
    assert.equal(JSON.parse(box.kv.get("snap:surveys:prod")).data[0].id, "sample-survey", "寫回 KV");
  });

  test("測試環境讀 snap:surveys:staging", async () => {
    _resetSnapshotMemory();
    const box = fakeEnv();
    box.kv.set("snap:surveys:staging", encodeSnapshot([{ id: "sample-survey", def: sampleDef(), startsAt: null, endsAt: null }]));
    const r = await (await call(null, { method: "GET", path: "/v2/surveys", query: "?lang=en&v=2.11.0", env: { ...box.env, SNAPSHOT_ENV: "staging" }, neonSql: neonFor(box, []) })).json();
    assert.deepEqual(r.surveys.map((s) => s.id), ["sample-survey"]);
    assert.deepEqual(box.neon, []);
  });

  test("送出完成剛好額滿：重建 KV 的問卷快照，把它拿掉", async () => {
    _resetSnapshotMemory();
    const box = fakeEnv({ snapshot: [{ id: "sample-survey", def: sampleDef(), startsAt: null, endsAt: null }] });
    const waits = [];
    const neonSql = neonFor(box, (q) => {
      if (/from surveys where id = \$1 and status = 'published'/.test(q)) return [{ def: sampleDef(), ended: false }];
      if (/update surveys set completed_count/.test(q)) return [{ just_ended: true }];
      return []; // 重建快照：已經沒有進行中的問卷
    });
    const res = await call(null, { path: "/v2/surveys/responses", body: answer({ final: true }), env: box.env, neonSql, ctx: { waitUntil: (p) => waits.push(p) } });
    assert.equal(res.status, 200);
    await Promise.all(waits);
    assert.deepEqual(JSON.parse(box.kv.get("snap:surveys:prod")).data, [], "額滿的問卷從清單拿掉");
  });
});
