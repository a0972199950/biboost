// 問卷與匿名統計：survey.js（背景：清單、門檻、輪替、送出）、survey-ui.js（畫面）、survey-page.js（觸發時機與心跳）、
// main-hook.js 的地區限定偵測與影片狀態、公告連結。後台用假回應；問卷是跟產品無關的通用內容（下發格式同 report worker 的 /v2/surveys）。
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, fakeResponse, plain, closeAll } from "./helpers/load.mjs";

after(closeAll);

const L = (s) => ({ zh_TW: s, zh_CN: s, zh_HK: s, en: s, ja: s, ko: s });
const opts = (...ids) => ids.map((id) => ({ id, text: L(id) }));
const DEF = {
  id: "sample-a", title: L("TITLE"), weight: 1, minExtVersion: "2.10.1",
  prompt: { invite: L("INVITE"), region_blocked: L("EVENT") },
  triggers: { invite: true, events: ["region_blocked"] },
  questions: [
    { id: "q_devices", type: "multi", required: true, showIf: null, text: L("devices?"), options: opts("pc", "phone") },
    { id: "q_freq", type: "single", required: true, text: L("freq?"), options: opts("often", "rarely"), next: { rules: [{ in: ["often"], to: "q_what" }], else: "q_email" } },
    { id: "q_what", type: "multi", required: true, text: L("what?"), options: opts("anime", "movie", "other") },
    { id: "q_what_other", type: "text", required: false, inline: true, maxLength: 200, showIf: { q: "q_what", in: ["other"] }, text: L("other detail?") },
    { id: "q_email", type: "email", required: false, showIf: null, text: L("email?") },
    { id: "q_feature", type: "longtext", required: false, showIf: null, text: L("feature?"), maxLength: 500 }
  ]
};
// 第二份：只參加頁面邀請、選項隨機排序
const DEF_B = {
  id: "sample-b", title: L("B"), weight: 1, minExtVersion: "2.10.1", prompt: { invite: L("INVITE B") }, triggers: { invite: true, events: [] },
  questions: [{ id: "q_pick", type: "single", required: true, showIf: null, shuffle: true, text: L("pick?"), options: opts("x", "y", "z") }]
};
// 第三份：只接事件
const DEF_C = {
  id: "sample-c", title: L("C"), weight: 1, minExtVersion: "2.10.1", prompt: { invite: L("INVITE C") }, triggers: { invite: false, events: ["region_blocked"] },
  questions: [{ id: "q_c", type: "single", required: true, showIf: null, text: L("c?"), options: opts("c1", "c2") }]
};
const API = "https://api.biboost.app";
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------
// survey.js（背景）
// ---------------------------------------------------------------------------------------------
function bootBg({ storage = {}, surveys = [DEF], server = {}, ua, welcome = false, sync } = {}) {
  const env = createEnv({ url: "chrome-extension://bcs-test/background.js", storage, sync });
  if (ua) Object.defineProperty(env.window.navigator, "userAgent", { value: ua, configurable: true });
  env.load("features.js").load("survey-core.js").load("survey.js");
  env.chrome.runtime.getContexts = () => Promise.resolve(welcome ? [{ contextType: "TAB", documentUrl: "chrome-extension://bcs-test/welcome.html" }] : []);
  const calls = [];
  const srv = { list: () => fakeResponse({ body: { surveys } }), responses: () => fakeResponse({ body: { ok: true } }), batch: () => fakeResponse({ status: 204 }), event: () => fakeResponse({ status: 204 }), ...server };
  env.fetchHandler = (url, init = {}) => {
    const u = new URL(url);
    const call = {
      method: init.method || "GET", path: u.pathname, query: u.search, body: init.body ? JSON.parse(init.body) : undefined,
      contentType: init.headers && init.headers["Content-Type"], keepalive: !!init.keepalive
    };
    calls.push(call);
    if (u.pathname === "/v2/surveys") return srv.list(call);
    if (u.pathname === "/v2/surveys/responses") return srv.responses(call);
    if (u.pathname === "/v2/surveys/events/batch") return srv.batch(call);
    if (u.pathname === "/v2/surveys/events") return srv.event(call);
    return fakeResponse({ status: 204 });
  };
  const S = env.internals("survey");
  const begin = (entry, more = {}) => S.begin({ entry, lang: "en", ...more }).then(plain);
  const posted = (path) => calls.filter((c) => c.path === path).map((c) => c.body);
  // 送到伺服器的問卷事件（批次拆開、逐筆照原樣），依送出順序
  const events = () => plain(calls.flatMap((c) => {
    if (c.path === "/v2/surveys/events") return [c.body];
    if (c.path !== "/v2/surveys/events/batch") return [];
    const { events: list, ...head } = c.body;
    return list.map((e) => ({ ...head, ...e }));
  }));
  return { env, S, calls, begin, posted, events, states: () => env.storage.surveyStates || {} };
}

describe("匿名統計：心跳與地區限定計數", () => {
  test("沒被抽中（telemetrySample=false）的安裝不送心跳", async () => {
    const { env, S, calls } = bootBg({ storage: { telemetrySample: false } });
    await S.heartbeat();
    assert.equal(calls.length, 0);
    env.close();
  });
  test("被抽中的安裝送心跳：POST 空內容到 /v1/telemetry/heartbeat，不帶 Cookie", async () => {
    const { env, S, calls } = bootBg({ storage: { telemetrySample: true } });
    await S.heartbeat();
    assert.deepEqual(plain(calls.map(({ method, path }) => ({ method, path }))), [{ method: "POST", path: "/v1/telemetry/heartbeat" }]);
    assert.equal(env.fetchCalls[0].url, API + "/v1/telemetry/heartbeat");
    assert.equal(env.fetchCalls[0].init.credentials, "omit");
    assert.equal(env.fetchCalls[0].init.body, undefined);
    env.close();
  });
  test("第一次要送時抽籤並存起來（之後不再改）", async () => {
    const { env, S } = bootBg();
    await S.heartbeat();
    assert.equal(typeof env.storage.telemetrySample, "boolean");
    const first = env.storage.telemetrySample;
    for (let i = 0; i < 5; i++) await S.heartbeat();
    assert.equal(env.storage.telemetrySample, first);
    assert.equal(S.SAMPLE_RATE, 0.1);
    env.close();
  });
  test("抽樣比例約 10%", async () => {
    let yes = 0;
    for (let i = 0; i < 400; i++) {
      const { env, S } = bootBg();
      await S.heartbeat();
      if (env.storage.telemetrySample) yes++;
      env.close();
    }
    assert.ok(yes > 15 && yes < 75, "約 40/400，實際 " + yes);
  });
  test("遇到地區限定：每個安裝都送，不抽樣", async () => {
    const { env, S, calls } = bootBg({ storage: { telemetrySample: false } });
    await S.blocked();
    assert.deepEqual(calls.map((c) => c.path), ["/v1/telemetry/blocked"]);
    env.close();
  });
  test("後台失敗或連不上：靜默、不丟例外", async () => {
    const { env, S } = bootBg({ storage: { telemetrySample: true } });
    env.fetchHandler = () => { throw new TypeError("Failed to fetch"); };
    assert.equal(await S.heartbeat(), true);
    assert.equal(await S.blocked(), true);
    env.close();
  });
  test("Firefox：沒有同意 technicalAndInteraction 就不送；同意了才送", async () => {
    const FX = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
    const a = bootBg({ storage: { telemetrySample: true }, ua: FX });
    a.env.window.browser = { permissions: { contains: async () => false, request: async () => false } };
    await a.S.heartbeat(); await a.S.blocked();
    assert.equal(a.calls.length, 0);
    a.env.close();
    const b = bootBg({ storage: { telemetrySample: true }, ua: FX });
    let asked = null;
    b.env.window.browser = { permissions: { contains: async (p) => { asked = p; return true; }, request: async () => true } };
    await b.S.heartbeat();
    assert.equal(b.calls.length, 1);
    assert.deepEqual(plain(asked), { data_collection: ["technicalAndInteraction"] });
    b.env.close();
  });
});

describe("問卷：清單", () => {
  test("拿清單時帶介面語言與擴充版本；6 小時內用快取；公告與 console 一律重拿", async () => {
    const t = bootBg();
    await t.begin("invite");
    const lists = () => t.calls.filter((c) => c.path === "/v2/surveys");
    assert.equal(lists().length, 1);
    assert.match(lists()[0].query, /lang=en&v=\d/);
    t.env.storage.surveyStates = {}; t.env.storage.surveyLastShown = null;
    await t.begin("invite");
    assert.equal(lists().length, 1, "快取內不重拿");
    await t.begin("announcement", { surveyId: "sample-a" });
    assert.equal(lists().length, 2, "公告入口重拿");
    t.env.close();
  });
  test("連不上後台：用舊的快取；完全沒有快取就當沒有問卷；格式不對的問卷不用", async () => {
    const t = bootBg({ server: { list: () => { throw new TypeError("offline"); } } });
    assert.equal((await t.begin("invite")).reason, "none");
    t.env.close();
    const u = bootBg({ surveys: [DEF, { id: "broken", questions: [] }] });
    await u.begin("invite");
    assert.deepEqual(u.env.storage.surveyList.surveys.map((s) => s.id), ["sample-a"]);
    u.env.storage.surveyList.at = 0; // 過期
    u.env.storage.surveyStates = {}; u.env.storage.surveyLastShown = null;
    u.env.fetchHandler = () => { throw new TypeError("offline"); };
    assert.equal((await u.begin("invite")).ok, true, "過期的快取也比沒有好");
    u.env.close();
  });
});

describe("問卷：什麼時候出現（門檻與輪替）", () => {
  test("頁面邀請：出現、記下出現時間與今天、發 response_id；觸發機會記「出現了」、事件記 shown", async () => {
    const t = bootBg();
    const r = await t.begin("invite");
    assert.equal(r.ok, true);
    assert.equal(r.def.id, "sample-a");
    assert.match(r.responseId, /^[0-9a-f]{32}$/);
    const st = t.states()["sample-a"];
    assert.equal(st.responseId, r.responseId);
    assert.ok(st.shownAt > 0);
    assert.equal(t.env.storage.surveyLastShown.id, "sample-a");
    await t.env.settle(20);
    assert.deepEqual(plain(t.posted("/v2/surveys/triggers")), [{ trigger: "invite", result: "shown" }]);
    await t.S.flushEvents();
    const ev = t.events()[0];
    assert.equal(ev.kind, "shown");
    assert.equal(ev.survey_id, "sample-a");
    assert.equal(ev.response_id, r.responseId);
    assert.equal(ev.entry, "invite");
    t.env.close();
  });
  test("今天出現過、但沒關掉也沒填完（重新整理、換頁）：今天不再出現任何問卷，頁面邀請與事件都一樣", async () => {
    const t = bootBg({ surveys: [DEF, DEF_B] });
    assert.equal((await t.begin("invite", { rand: () => 0 })).ok, true);
    assert.equal((await t.begin("invite")).reason, "today");
    assert.equal((await t.begin("region_blocked")).reason, "today");
    assert.equal((await t.begin("announcement", { surveyId: "sample-b" })).ok, true, "公告不看門檻");
    t.env.close();
  });
  test("昨天出現過但沒處理：不起算 3 天冷卻，今天照樣可以出現（接著同一份草稿）", async () => {
    const t = bootBg();
    const first = await t.begin("invite");
    t.env.storage.surveyLastShown = { day: "2000-1-1", id: "sample-a" };
    const again = await t.begin("invite");
    assert.equal(again.ok, true);
    assert.equal(again.responseId, first.responseId);
    t.env.close();
  });
  test("關掉（按 × 或 Esc）：這份不再自動出現；3 天內頁面邀請不出現，事件可以出現別份", async () => {
    const t = bootBg({ surveys: [DEF, DEF_C] });
    const r = await t.begin("invite");
    await t.S.closed({ surveyId: r.def.id, page: 2, entry: "invite", lang: "en" });
    const st = t.states()["sample-a"];
    assert.ok(st.closedAt > 0);
    assert.equal(t.env.storage.surveyLastEndedAt, st.closedAt);
    assert.equal((await t.begin("invite")).reason, "cooldown");
    const ev = await t.begin("region_blocked");
    assert.equal(ev.ok, true, "事件不受 3 天冷卻");
    assert.equal(ev.def.id, "sample-c", "關掉的那份不會再出現");
    await t.env.settle(20);
    const closedEv = t.events().find((e) => e.kind === "closed");
    assert.deepEqual([closedEv.survey_id, closedEv.page], ["sample-a", 2]);
    t.env.close();
  });
  test("關掉或填完滿 3 天後，頁面邀請出下一份；全部都關掉或填完就沒有候選", async () => {
    const t = bootBg({ surveys: [DEF, DEF_B], storage: { surveyStates: { "sample-a": { closedAt: Date.now() - 4 * DAY, responseId: "a".repeat(32) } }, surveyLastEndedAt: Date.now() - 4 * DAY } });
    const r = await t.begin("invite");
    assert.equal(r.def.id, "sample-b");
    t.env.storage.surveyStates["sample-b"].doneAt = Date.now() - 4 * DAY;
    t.env.storage.surveyLastEndedAt = Date.now() - 4 * DAY;
    assert.equal((await t.begin("invite")).reason, "none");
    t.env.close();
  });
  test("新安裝 3 天內：頁面邀請不出現；事件照樣出現；沒有 installedAt 的舊安裝不算新安裝", async () => {
    const t = bootBg({ storage: { installedAt: Date.now() - 2.9 * DAY } });
    assert.equal((await t.begin("invite")).reason, "new_install");
    assert.equal(t.states()["sample-a"], undefined, "沒出現就不記");
    assert.equal((await t.begin("region_blocked")).ok, true);
    t.env.close();
    const u = bootBg({ storage: { installedAt: Date.now() - 3.1 * DAY } });
    assert.equal((await u.begin("invite")).ok, true);
    u.env.close();
    const v = bootBg();
    assert.equal((await v.begin("invite")).ok, true);
    v.env.close();
  });
  test("歡迎視窗開著：頁面邀請與事件都不出現；公告照樣打開", async () => {
    const t = bootBg({ welcome: true });
    assert.equal((await t.begin("invite")).reason, "welcome");
    assert.equal((await t.begin("region_blocked")).reason, "welcome");
    assert.equal((await t.begin("announcement", { surveyId: "sample-a" })).ok, true);
    await t.env.settle(20);
    assert.deepEqual(plain(t.posted("/v2/surveys/triggers")), [{ trigger: "invite", result: "welcome" }, { trigger: "region_blocked", result: "welcome" }]);
    t.env.close();
  });
  test("事件只挑有接這個事件的問卷；頁面邀請只挑有參加頁面邀請的", async () => {
    const t = bootBg({ surveys: [DEF_B, DEF_C] });
    assert.equal((await t.begin("region_blocked")).def.id, "sample-c");
    t.env.close();
    const u = bootBg({ surveys: [DEF_C] });
    assert.equal((await u.begin("invite")).reason, "none");
    u.env.close();
  });
  test("好幾份候選時依權重隨機挑", async () => {
    const t = bootBg();
    const list = [{ id: "a", weight: 1 }, { id: "b", weight: 3 }];
    assert.equal(t.S.pickWeighted(list, () => 0.2).id, "a");
    assert.equal(t.S.pickWeighted(list, () => 0.3).id, "b");
    assert.equal(t.S.pickWeighted(list, () => 0.99).id, "b");
    t.env.close();
  });
  test("公告與 console：指定問卷（填過也能開：重填，同一個 response_id、從空白開始）；不在清單上（結束了）回 ended；沒指定先挑還沒填完的", async () => {
    const t = bootBg({ surveys: [DEF, DEF_B], storage: { surveyStates: { "sample-a": { doneAt: 1, closedAt: 2, responseId: "a".repeat(32), answers: {} } } } });
    const again = await t.begin("announcement", { surveyId: "sample-a" });
    assert.deepEqual([again.ok, again.def.id, again.responseId, again.answers], [true, "sample-a", "a".repeat(32), {}]);
    assert.equal((await t.begin("announcement", { surveyId: "gone-survey" })).reason, "ended");
    assert.equal((await t.begin("console")).def.id, "sample-b");
    assert.equal((await t.begin("console", { surveyId: "sample-b" })).entry, "console");
    assert.equal((await t.begin("click")).reason, "unavailable", "不認得的入口");
    t.env.close();
    // 都填過了：沒指定也挑一份（重填），不再回「已經填過」
    const u = bootBg({ surveys: [DEF], storage: { surveyStates: { "sample-a": { doneAt: 1, responseId: "a".repeat(32) } } } });
    const r = await u.begin("announcement");
    assert.deepEqual([r.ok, r.def.id, r.responseId], [true, "sample-a", "a".repeat(32)]);
    u.env.close();
    const w = bootBg({ surveys: [] });
    assert.equal((await w.begin("announcement")).reason, "ended");
    w.env.close();
  });
  test("同時兩個分頁觸發：只出現一份（第二個看到今天已經出現過）", async () => {
    const t = bootBg({ surveys: [DEF, DEF_B] });
    const [a, b] = await Promise.all([t.begin("invite"), t.begin("invite")]);
    assert.deepEqual([a.ok, b.ok, b.reason], [true, false, "today"]);
    t.env.close();
  });
  test("中途離開再打開：同一個 response_id、帶回已答的；隨機排序的選項順序第一次決定後就固定", async () => {
    const t = bootBg({ surveys: [DEF_B] });
    const first = await t.begin("invite");
    assert.deepEqual([...first.order["q_pick"]].sort(), ["x", "y", "z"]);
    await t.S.submit({ surveyId: "sample-b", answers: { q_pick: "y" }, final: false, entry: "invite", lang: "en" });
    t.env.storage.surveyLastShown = null;
    const second = await t.begin("invite");
    assert.equal(second.responseId, first.responseId);
    assert.deepEqual(second.answers, { q_pick: "y" });
    assert.deepEqual(second.order, first.order);
    t.env.close();
  });
});

describe("問卷：送出 submit 與事件", () => {
  test("只送目前路徑上的答案：換了一條路，原本那條路上的答案（就算畫面還帶著）不送", async () => {
    const t = bootBg();
    await t.begin("announcement", { surveyId: "sample-a" });
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "rarely", q_what: ["anime"], q_what_other: "x" }, final: false, entry: "announcement", lang: "en" });
    assert.deepEqual(plain(t.posted("/v2/surveys/responses")[0].answers), { q_devices: ["pc"], q_freq: "rarely" });
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "often", q_what: ["other"], q_what_other: "x" }, final: false, entry: "announcement", lang: "en" });
    assert.deepEqual(plain(t.posted("/v2/surveys/responses")[1].answers), { q_devices: ["pc"], q_freq: "often", q_what: ["other"], q_what_other: "x" });
    t.env.close();
  });
  test("每答一題送一次：帶問卷 id、response_id、答案（只留定義裡有的題目）與自動附帶欄位", async () => {
    const t = bootBg({ storage: { installedAt: Date.now() - 10 * DAY, cdnMode: "custom" } });
    const r = await t.begin("region_blocked");
    assert.equal((await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], junk: 1, q_email: "" }, final: false, entry: "region_blocked", lang: "zh_HK" })).ok, true);
    const body = t.posted("/v2/surveys/responses")[0];
    assert.deepEqual(plain(body), {
      survey_id: "sample-a", response_id: r.responseId, answers: { q_devices: ["pc"] }, final: false, entry: "region_blocked",
      client: { browser: body.client.browser, ext_version: body.client.ext_version, lang: "zh_HK", install_days: "7_30", custom_nodes: true }
    });
    assert.deepEqual(plain(t.states()["sample-a"].answers), { q_devices: ["pc"] }, "草稿存在本機");
    t.env.close();
  });
  test("沒有 installedAt（舊安裝）＝>90 天；從沒用過自訂節點＝false", async () => {
    const t = bootBg();
    await t.begin("announcement", { surveyId: "sample-a" });
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"] }, final: false, entry: "announcement", lang: "en" });
    const c = t.posted("/v2/surveys/responses")[0].client;
    assert.equal(c.install_days, "gt90");
    assert.equal(c.custom_nodes, false);
    t.env.close();
  });
  test("送出完成：記下填完（不再出現）、3 天冷卻從現在起算、草稿清掉、事件記 completed", async () => {
    const t = bootBg();
    await t.begin("invite");
    assert.equal((await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "rarely" }, final: true, entry: "invite", lang: "en" })).ok, true);
    const st = t.states()["sample-a"];
    assert.ok(st.doneAt > 0);
    assert.deepEqual(plain(st.answers), {});
    assert.equal(t.env.storage.surveyLastEndedAt, st.doneAt);
    t.env.storage.surveyLastShown = null;
    assert.equal((await t.begin("invite")).reason, "cooldown");
    const again = await t.begin("announcement", { surveyId: "sample-a" });
    assert.equal(again.ok, true, "填過的從公告照樣能開（重填）");
    assert.deepEqual(again.answers, {});
    await t.env.settle(20);
    assert.ok(t.events().some((e) => e.kind === "completed"));
    t.env.close();
  });
  test("送出失敗（網路、5xx、限流）：不記填完，讓使用者重試；問卷已經不存在回 gone", async () => {
    const codes = [{ status: 500, reason: "server" }, { status: 429, reason: "rate_limited" }, { status: 404, reason: "gone" }];
    for (const c of codes) {
      const t = bootBg({ server: { responses: () => fakeResponse({ status: c.status, body: {} }) } });
      await t.begin("invite");
      assert.deepEqual(plain(await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"] }, final: true, entry: "invite", lang: "en" })), { ok: false, reason: c.reason });
      assert.equal(t.states()["sample-a"].doneAt, undefined);
      t.env.close();
    }
    const n = bootBg({ server: { responses: () => { throw new TypeError("offline"); } } });
    await n.begin("invite");
    assert.equal((await n.S.submit({ surveyId: "sample-a", answers: {}, final: true, entry: "invite", lang: "en" })).reason, "network");
    n.env.close();
  });
  test("還沒開始過（沒有 response_id）、或清單裡沒有這份問卷：不送", async () => {
    const t = bootBg();
    assert.equal((await t.S.submit({ surveyId: "sample-a", answers: {}, final: false, entry: "invite", lang: "en" })).reason, "unavailable");
    assert.equal(t.calls.filter((c) => c.path === "/v2/surveys/responses").length, 0);
    t.env.close();
  });
  test("換頁事件：第幾頁、哪一題、停留多久", async () => {
    const t = bootBg();
    await t.begin("invite");
    await t.S.pageEvent({ surveyId: "sample-a", page: 1, question: "q_devices", ms: 3200, entry: "invite", lang: "en" });
    await t.S.flushEvents();
    const e = t.events().find((x) => x.kind === "page");
    assert.deepEqual([e.page, e.question, e.ms, e.entry], [1, "q_devices", 3200, "invite"]);
    t.env.close();
  });
  test("Firefox：Email 要 personallyIdentifyingInfo 權限；被拒絕就不送 Email，其他答案照送", async () => {
    const FX = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
    const t = bootBg({ ua: FX });
    const asked = [];
    t.env.window.browser = { permissions: { contains: async () => false, request: async (p) => { asked.push(p); return false; } } };
    await t.begin("announcement", { surveyId: "sample-a" });
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "rarely", q_email: "me@example.com" }, final: true, entry: "announcement", lang: "en", telemetryConsent: true });
    assert.deepEqual(plain(asked), [{ data_collection: ["technicalAndInteraction", "personallyIdentifyingInfo"] }]);
    assert.equal(t.posted("/v2/surveys/responses")[0].answers.q_email, undefined);
    assert.deepEqual(t.posted("/v2/surveys/responses")[0].answers.q_devices, ["pc"]);
    t.env.close();
  });
  test("Firefox：同意了就一起送 Email；Chrome 直接送、不問權限", async () => {
    const FX = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
    const t = bootBg({ ua: FX });
    t.env.window.browser = { permissions: { contains: async () => true, request: async () => true } };
    await t.begin("announcement", { surveyId: "sample-a" });
    await t.S.submit({ surveyId: "sample-a", answers: { q_email: "me@example.com" }, final: false, entry: "announcement", lang: "en" });
    assert.equal(t.posted("/v2/surveys/responses")[0].answers.q_email, "me@example.com");
    t.env.close();
    const c = bootBg();
    await c.begin("announcement", { surveyId: "sample-a" });
    await c.S.submit({ surveyId: "sample-a", answers: { q_email: "me@example.com" }, final: true, entry: "announcement", lang: "en" });
    assert.equal(c.posted("/v2/surveys/responses")[0].answers.q_email, "me@example.com");
    c.env.close();
  });
  test("reset：清掉本機的問卷紀錄（含單一問卷時期的舊紀錄）", async () => {
    const t = bootBg({ storage: { surveyState: { done: true }, surveyDef: { at: 1 }, installedAt: 5 } });
    await t.begin("invite");
    await t.S.reset();
    for (const k of ["surveyList", "surveyStates", "surveyLastEndedAt", "surveyLastShown", "surveyState", "surveyDef"]) assert.equal(t.env.storage[k], undefined, k);
    assert.equal(t.env.storage.installedAt, 5);
    t.env.close();
  });
});

describe("問卷：請求的 Content-Type（不觸發 CORS 預檢）", () => {
  test("作答、觸發機會、事件都用 text/plain；心跳與計數不帶內容也不帶標頭", async () => {
    const t = bootBg({ storage: { telemetrySample: true } });
    await t.begin("invite");
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"] }, final: false, entry: "invite", lang: "en" });
    await t.S.flushEvents();
    await t.S.heartbeat();
    await t.S.blocked();
    await t.env.settle(20);
    const posts = t.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v2/"));
    assert.deepEqual([...new Set(posts.map((c) => c.path))].sort(), ["/v2/surveys/events/batch", "/v2/surveys/responses", "/v2/surveys/triggers"]);
    for (const c of posts) assert.equal(c.contentType, "text/plain;charset=UTF-8", c.path);
    const pings = t.env.fetchCalls.filter((c) => /\/v1\/telemetry\//.test(c.url));
    assert.equal(pings.length, 2);
    for (const p of pings) { assert.equal(p.init.method, "POST"); assert.equal(p.init.headers, undefined); assert.equal(p.init.body, undefined); }
    t.env.close();
  });
});

describe("問卷：事件合併送出（/v2/surveys/events/batch）", () => {
  const FX = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";
  const page = (t, n, more = {}) => t.S.pageEvent({ surveyId: "sample-a", page: n, question: "q" + n, ms: n * 100, entry: "invite", lang: "en", ...more });
  const batches = (t) => t.calls.filter((c) => c.path === "/v2/surveys/events/batch");
  const singles = (t) => t.calls.filter((c) => c.path === "/v2/surveys/events");

  test("出現、換頁先放在佇列不送；關掉時整批一次送出，順序照發生的順序", async () => {
    const t = bootBg();
    const r = await t.begin("invite");
    await page(t, 1); await page(t, 2);
    await t.env.settle(50);
    assert.equal(batches(t).length, 0, "還沒到送出的時機");
    await t.S.closed({ surveyId: "sample-a", page: 3, entry: "invite", lang: "en" });
    await t.env.settle(20);
    assert.equal(batches(t).length, 1);
    assert.equal(singles(t).length, 0);
    const b = batches(t)[0];
    assert.equal(b.method, "POST");
    assert.deepEqual(Object.keys(b.body).sort(), ["client", "entry", "events", "response_id", "survey_id"]);
    assert.deepEqual([b.body.survey_id, b.body.response_id, b.body.entry], ["sample-a", r.responseId, "invite"]);
    assert.deepEqual(Object.keys(b.body.client).sort(), ["browser", "custom_nodes", "ext_version", "install_days", "lang"]);
    assert.deepEqual(plain(b.body.events), [
      { kind: "shown" },
      { kind: "page", page: 1, question: "q1", ms: 100 },
      { kind: "page", page: 2, question: "q2", ms: 200 },
      { kind: "closed", page: 3 }
    ]);
    assert.equal(b.keepalive, false);
    t.env.close();
  });
  test("作答完成（completed）時送出", async () => {
    const t = bootBg();
    await t.begin("invite");
    await page(t, 1);
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "rarely" }, final: true, entry: "invite", lang: "en" });
    await t.env.settle(20);
    assert.equal(batches(t).length, 1);
    assert.deepEqual(plain(batches(t)[0].body.events.map((e) => e.kind)), ["shown", "page", "completed"]);
    t.env.close();
  });
  test("滿 50 筆就送出，第 51 筆留到下一批", async () => {
    const t = bootBg();
    await t.begin("invite");
    for (let i = 1; i <= 49; i++) await page(t, i);
    await t.env.settle(20);
    assert.equal(t.S.EVENT_BATCH_MAX, 50);
    assert.equal(batches(t).length, 1);
    assert.equal(batches(t)[0].body.events.length, 50);
    await page(t, 50);
    await t.env.settle(20);
    assert.equal(batches(t).length, 1, "第 51 筆還在佇列");
    await t.S.flushEvents();
    assert.equal(batches(t).length, 2);
    assert.deepEqual(plain(batches(t)[1].body.events), [{ kind: "page", page: 50, question: "q50", ms: 5000 }]);
    assert.deepEqual(t.events().map((e) => e.kind === "page" ? e.page : e.kind), ["shown", ...Array.from({ length: 50 }, (_, i) => i + 1)], "一筆不少、順序不變");
    t.env.close();
  });
  test("換了問卷（或 response_id、entry）：先把前一批送出，再開新的一批；整體順序不變", async () => {
    const t = bootBg({ surveys: [DEF, DEF_B] });
    const a = await t.begin("invite", { rand: () => 0 });
    await page(t, 1);
    const b = await t.begin("announcement", { surveyId: "sample-b" });
    await t.S.flushEvents();
    assert.equal(batches(t).length, 2);
    assert.deepEqual(plain(batches(t).map((c) => [c.body.survey_id, c.body.response_id, c.body.entry, c.body.events.map((e) => e.kind)])), [
      ["sample-a", a.responseId, "invite", ["shown", "page"]],
      ["sample-b", b.responseId, "announcement", ["shown"]]
    ]);
    t.env.close();
  });
  test("第一筆加入後過一段時間（EVENT_FLUSH_MS）自動送出", async () => {
    const t = bootBg();
    assert.ok(t.S.EVENT_FLUSH_MS > 0 && t.S.EVENT_FLUSH_MS < 30000, "比 Service Worker 閒置被停掉的 30 秒短");
    t.S.setEventFlushMs(40);
    await t.begin("invite");
    await page(t, 1);
    assert.equal(batches(t).length, 0);
    await t.env.settle(120);
    assert.equal(batches(t).length, 1);
    assert.deepEqual(plain(batches(t)[0].body.events.map((e) => e.kind)), ["shown", "page"]);
    await t.env.settle(120);
    assert.equal(batches(t).length, 1, "送完就沒有計時器了，不會送空的批次");
    t.env.close();
  });
  test("頁面關掉或隱藏（flushEvents({ keepalive: true })）：立刻送出，用 keepalive；佇列空的時候不送", async () => {
    const t = bootBg();
    await t.S.flushEvents({ keepalive: true });
    assert.equal(t.calls.filter((c) => c.path.startsWith("/v2/surveys/events")).length, 0);
    await t.begin("invite");
    await page(t, 1);
    await t.S.flushEvents({ keepalive: true });
    assert.equal(batches(t).length, 1);
    assert.equal(batches(t)[0].keepalive, true);
    assert.equal(batches(t)[0].body.events.length, 2);
    t.env.close();
  });
  for (const status of [404, 405]) {
    test(`批次端點回 ${status}（伺服器還沒有）：這批逐筆送舊的 /v2/surveys/events（順序、內容同舊版），之後不再試批次`, async () => {
      const t = bootBg({ server: { batch: () => fakeResponse({ status, body: { ok: false, error: "not_found" } }) } });
      const r = await t.begin("invite");
      await page(t, 1);
      await t.S.closed({ surveyId: "sample-a", page: 2, entry: "invite", lang: "en" });
      await t.env.settle(20);
      assert.equal(batches(t).length, 1);
      const client = batches(t)[0].body.client;
      assert.deepEqual(plain(singles(t).map((c) => c.body)), [
        { survey_id: "sample-a", response_id: r.responseId, entry: "invite", client, kind: "shown" },
        { survey_id: "sample-a", response_id: r.responseId, entry: "invite", client, kind: "page", page: 1, question: "q1", ms: 100 },
        { survey_id: "sample-a", response_id: r.responseId, entry: "invite", client, kind: "closed", page: 2 }
      ]);
      for (const c of singles(t)) assert.equal(c.contentType, "text/plain;charset=UTF-8");
      await t.begin("announcement", { surveyId: "sample-a" });
      await t.S.flushEvents({ keepalive: true });
      assert.equal(batches(t).length, 1, "這次執行期間不再試批次");
      assert.equal(singles(t).length, 4);
      assert.equal(singles(t)[3].body.kind, "shown");
      assert.equal(singles(t)[3].keepalive, true);
      t.env.close();
    });
  }
  test("網路錯誤、5xx、400、429：靜默丟掉、不重試、不改送逐筆；下一批照樣用批次", async () => {
    for (const fail of [() => { throw new TypeError("offline"); }, () => fakeResponse({ status: 500 }), () => fakeResponse({ status: 400, body: { ok: false, error: "bad_kind" } }), () => fakeResponse({ status: 429 })]) {
      const t = bootBg({ server: { batch: fail } });
      await t.begin("invite");
      await t.S.flushEvents();
      await t.env.settle(20);
      assert.equal(batches(t).length, 1);
      assert.equal(singles(t).length, 0);
      await page(t, 1);
      await t.S.flushEvents();
      assert.equal(batches(t).length, 2, "沒有重送第一批，第二批照樣試批次");
      assert.deepEqual(plain(batches(t)[1].body.events), [{ kind: "page", page: 1, question: "q1", ms: 100 }]);
      t.env.close();
    }
  });
  test("Firefox：沒同意匿名統計就不放進佇列、什麼都不送；同意了才送", async () => {
    const a = bootBg({ ua: FX });
    a.env.window.browser = { permissions: { contains: async () => false, request: async () => false } };
    await a.begin("invite");
    await page(a, 1);
    await a.S.closed({ surveyId: "sample-a", page: 2, entry: "invite", lang: "en" });
    await a.S.flushEvents({ keepalive: true });
    await a.env.settle(20);
    assert.equal(a.calls.filter((c) => c.path.startsWith("/v2/surveys/events")).length, 0);
    a.env.close();
    const b = bootBg({ ua: FX });
    b.env.window.browser = { permissions: { contains: async () => true, request: async () => true } };
    await b.begin("invite");
    await page(b, 1);
    await b.S.flushEvents();
    assert.equal(batches(b).length, 1);
    assert.deepEqual(plain(batches(b)[0].body.events.map((e) => e.kind)), ["shown", "page"]);
    assert.equal(batches(b)[0].body.client.browser, "firefox");
    b.env.close();
  });
});

describe("問卷：填過的紀錄同步到 chrome.storage.sync", () => {
  const RA = "a".repeat(32), RB = "b".repeat(32);
  const finalA = (t, entry = "invite") => t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"], q_freq: "rarely" }, final: true, entry, lang: "en" });
  test("送出完成：sync 記下 { d: doneAt, r: responseId }，不存答案；草稿不寫 sync", async () => {
    const t = bootBg({ sync: {} });
    const r = await t.begin("invite");
    await t.S.submit({ surveyId: "sample-a", answers: { q_devices: ["pc"] }, final: false, entry: "invite", lang: "en" });
    assert.equal(t.env.syncStorage.surveyDone, undefined, "草稿不寫 sync");
    await finalA(t);
    const st = t.states()["sample-a"];
    assert.deepEqual(plain(t.env.syncStorage.surveyDone), { "sample-a": { d: st.doneAt, r: r.responseId } });
    t.env.close();
  });
  test("sync 有填過（這台沒有紀錄，例如別台電腦或重裝）：頁面邀請、事件都不出現；公告照樣能開，沿用 sync 的 response_id、從空白開始", async () => {
    const sync = { surveyDone: { "sample-a": { d: 100, r: RA } } };
    const t = bootBg({ sync, storage: { installedAt: Date.now() - 10 * DAY } });
    assert.equal((await t.begin("invite")).reason, "none");
    t.env.close();
    const e = bootBg({ sync, surveys: [{ ...DEF, triggers: { invite: false, events: ["region_blocked"] } }] });
    assert.equal((await e.begin("region_blocked")).reason, "none");
    e.env.close();
    const a = bootBg({ sync });
    const r = await a.begin("announcement", { surveyId: "sample-a" });
    assert.deepEqual([r.ok, r.responseId, r.answers], [true, RA, {}]);
    await finalA(a, "announcement");
    assert.equal(a.posted("/v2/surveys/responses")[0].response_id, RA, "重填覆蓋伺服器上同一筆");
    const st = a.states()["sample-a"];
    assert.ok(st.doneAt > 100, "重填送出後 doneAt 更新");
    assert.deepEqual(plain(a.env.syncStorage.surveyDone["sample-a"]), { d: st.doneAt, r: RA });
    a.env.close();
  });
  test("本機與 sync 的 response_id 不同：以 sync 為準；任一邊有 doneAt 就算填過", async () => {
    const t = bootBg({ sync: { surveyDone: { "sample-a": { d: 5, r: RB } } }, storage: { surveyStates: { "sample-a": { responseId: RA, shownAt: 1, answers: {} } } } });
    const g = await t.S.getStates();
    assert.deepEqual([g.states["sample-a"].responseId, g.states["sample-a"].doneAt], [RB, 5]);
    await t.begin("announcement", { surveyId: "sample-a" });
    await finalA(t, "announcement");
    assert.equal(t.posted("/v2/surveys/responses")[0].response_id, RB);
    t.env.close();
    const u = bootBg({ sync: {}, storage: { surveyStates: { "sample-a": { responseId: RA, doneAt: 7 } } } });
    assert.equal((await u.S.getStates()).states["sample-a"].doneAt, 7, "只有本機有 doneAt 也算");
    u.env.close();
  });
  test("sync 裡格式不對的紀錄不採用", async () => {
    const t = bootBg({ sync: { surveyDone: { "sample-a": { d: "x", r: RA }, "sample-b": { d: 3, r: "not-hex" } } } });
    const g = await t.S.getStates();
    assert.equal(g.states["sample-a"], undefined);
    assert.deepEqual([g.states["sample-b"].doneAt, g.states["sample-b"].responseId], [3, undefined]);
    t.env.close();
  });
  test("只留 doneAt 最新的 SYNC_MAX 份（sync 單一項目 8KB 的配額）", async () => {
    const old = {};
    for (let i = 0; i < 60; i++) old["old-" + i] = { d: 1000 + i, r: RB };
    const t = bootBg({ sync: { surveyDone: old } });
    await t.begin("invite");
    await finalA(t);
    const m = t.env.syncStorage.surveyDone, max = t.S.SYNC_MAX;
    assert.equal(Object.keys(m).length, max);
    assert.ok(m["sample-a"], "剛填的留著");
    assert.ok(m["old-59"] && !m["old-0"], "最舊的被擠掉");
    assert.ok(JSON.stringify(m).length < 8192 * 0.75);
    t.env.close();
  });
  test("不支援 sync（沒有 chrome.storage.sync）或 sync 出錯：安靜退回只用本機", async () => {
    for (const sync of [undefined, "broken"]) {
      const t = bootBg({ sync });
      const r = await t.begin("invite");
      assert.equal(r.ok, true, String(sync));
      assert.equal((await finalA(t)).ok, true, String(sync));
      assert.ok(t.states()["sample-a"].doneAt > 0);
      t.env.storage.surveyLastShown = null;
      assert.equal((await t.begin("invite")).reason, "cooldown");
      assert.equal((await t.begin("announcement", { surveyId: "sample-a" })).responseId, r.responseId);
      await t.S.reset();
      t.env.close();
    }
  });
  test("reset：sync 裡填過的紀錄也清掉", async () => {
    const t = bootBg({ sync: { surveyDone: { "sample-a": { d: 1, r: RA } }, donorId: "keep" } });
    await t.S.reset();
    assert.equal(t.env.syncStorage.surveyDone, undefined);
    assert.equal(t.env.syncStorage.donorId, "keep", "sync 裡別的東西不動");
    t.env.close();
  });
});

// ---------------------------------------------------------------------------------------------
// survey-ui.js（畫面）
// ---------------------------------------------------------------------------------------------
const UI = { next: "NEXT", prev: "BACK", skipSubmit: "SKIP", submit: "SUBMIT", thanks: "THANKS", close: "CLOSE", consent: "CONSENT", fail: "FAIL", closedNotice: "GONE" };
function bootUi(extra = {}) {
  const env = createEnv({ url: "https://www.bilibili.com/" });
  // 畫面的計時器（成功動畫、關掉後的提示自動關）改成手動觸發
  const timers = new Map();
  let n = 0;
  env.window.setTimeout = (fn, ms) => { timers.set(++n, { fn, ms }); return n; };
  env.window.clearTimeout = (id) => { timers.delete(id); };
  const fire = (ms) => { const hit = Array.from(timers.entries()).filter(([, x]) => x.ms === ms); hit.forEach(([id, x]) => { timers.delete(id); x.fn(); }); return hit.length; };
  env.load("survey-core.js").load("survey-ui.js");
  const log = { answers: [], submits: [], closed: 0, infos: [] };
  const open = (o = {}) => env.window.BBSurveyUI.open({
    def: DEF, answers: {}, lang: "en", ui: UI, promptText: "PROMPT", showConsent: false,
    onAnswer: (a) => { log.answers.push(JSON.parse(JSON.stringify(a))); return Promise.resolve({ ok: true }); },
    onSubmit: (a, e) => { log.submits.push(JSON.parse(JSON.stringify({ a, e }))); return Promise.resolve(extra.submitResult || { ok: true }); },
    onClose: (info) => { log.closed++; log.infos.push(info); },
    ...o
  });
  const root = () => env.document.querySelector("[data-bb-survey]").shadowRoot;
  const q = (sel) => root().querySelector(sel);
  const qa = (sel) => Array.from(root().querySelectorAll(sel));
  const btn = (text) => qa("button").find((b) => b.textContent === text);
  const text = () => root().querySelector(".card").textContent;
  const hosts = () => env.document.querySelectorAll("[data-bb-survey]").length;
  const esc = () => env.window.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape" }));
  return { env, open, log, root, q, qa, btn, text, timers, fire, hosts, esc };
}

describe("survey-ui.js：畫面", () => {
  test("pick：依語言挑，粵語沒有就用繁中，再退英文", () => {
    const { env } = bootUi();
    const pick = env.window.BBSurveyUI.pick;
    assert.equal(pick({ zh_TW: "繁", en: "E" }, "zh_HK"), "繁");
    assert.equal(pick({ en: "E", ja: "J" }, "ko"), "E");
    assert.equal(pick({ ja: "J" }, "ko"), "J");
    assert.equal(pick(null, "en"), "");
    env.close();
  });
  test("打開就是第 1 題，上方有品牌、說明文字、×，下方有進度點點與「第幾題/總題數」；內容用 textContent（不當 HTML）", () => {
    const t = bootUi();
    t.open();
    assert.match(t.text(), /PROMPT/);
    assert.match(t.q(".brand").textContent, /BiBoost/);
    assert.match(t.text(), /devices\?/);
    assert.equal(t.qa(".prog .dot").length, 3); // devices、freq、最後一頁（q_what 還看不到）
    assert.equal(t.qa(".prog .dot.on").length, 1);
    assert.ok(t.q(".prog .dot.cur"));
    assert.equal(t.q(".prog .count").textContent, "1/3");
    assert.equal(t.q(".x").getAttribute("aria-label"), "CLOSE");
    const hostStyle = t.env.document.querySelector("[data-bb-survey]").style.cssText;
    assert.match(hostStyle, /z-index:\s*2147483647/);
    t.env.close();
  });
  test("題目文字裡的 HTML 不會變成元素", () => {
    const t = bootUi();
    const def = JSON.parse(JSON.stringify(DEF));
    def.questions[0].text = L("<img src=x onerror=alert(1)>hi");
    t.open({ def });
    assert.equal(t.qa("img").length, 0);
    assert.match(t.text(), /<img src=x/);
    t.env.close();
  });
  test("複選：沒選時「下一題」不能按；選了才能，並送出目前答案", () => {
    const t = bootUi();
    t.open();
    const next = t.btn("NEXT");
    assert.equal(next.disabled, true);
    t.qa(".opt")[0].click();
    assert.equal(next.disabled, false);
    t.qa(".opt")[1].click();
    next.click();
    assert.deepEqual(t.log.answers.at(-1), { q_devices: ["pc", "phone"] });
    assert.match(t.text(), /freq\?/);
    t.env.close();
  });
  test("單選：點了就自動進下一題；有跳題（showIf 成立才出現第 3 題）", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    t.qa(".opt")[0].click(); // often
    assert.match(t.text(), /what\?/);
    t.env.close();
    const u = bootUi();
    u.open();
    u.qa(".opt")[0].click(); u.btn("NEXT").click();
    u.qa(".opt")[1].click(); // rarely → 跳過 q_what，直接最後一頁
    assert.doesNotMatch(u.text(), /what\?/);
    assert.match(u.text(), /email\?/);
    assert.match(u.text(), /feature\?/);
    u.env.close();
  });
  test("進度：往下一題時點點與題號跟著走；跳題成立時總題數變多", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    assert.equal(t.q(".prog .count").textContent, "2/3");
    assert.equal(t.qa(".prog .dot.on").length, 2);
    t.qa(".opt")[0].click(); // often → 多出 q_what
    assert.match(t.text(), /what\?/);
    assert.equal(t.q(".prog .count").textContent, "3/4");
    assert.equal(t.qa(".prog .dot").length, 4);
    t.env.close();
  });
  test("只有淺色：沒有深色模式的樣式", () => {
    const { env } = bootUi();
    assert.doesNotMatch(env.window.BBSurveyUI.CSS, /prefers-color-scheme/);
    env.close();
  });
  test("頁首：logo、產品名、伺服器下發的問卷標題；定義沒有標題就不畫", () => {
    const t = bootUi();
    t.open();
    assert.ok(t.q(".hrow .logo svg"));
    assert.ok(t.q(".logo .lbody .hand"), "logo 的舉手動畫");
    assert.equal(t.q(".hrow .title").textContent, "TITLE");
    t.env.close();
    const u = bootUi();
    const def = JSON.parse(JSON.stringify(DEF));
    delete def.title;
    u.open({ def });
    assert.equal(u.q(".title"), null);
    u.env.close();
  });
  test("每一頁都有上一題、下一題：第一頁的上一題不能按；單選題沒選時下一題不能按，回頭看時可以照原答案按下一題", () => {
    const t = bootUi();
    t.open();
    assert.equal(t.btn("BACK").disabled, true);
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    assert.match(t.text(), /freq\?/);
    assert.equal(t.btn("BACK").disabled, false);
    assert.equal(t.btn("NEXT").disabled, true, "單選題還沒選");
    t.qa(".opt")[1].click(); // rarely → 自動到最後一頁
    assert.match(t.text(), /email\?/);
    assert.equal(t.btn("BACK").disabled, false);
    t.btn("BACK").click();
    assert.match(t.text(), /freq\?/);
    assert.equal(t.btn("NEXT").disabled, false);
    t.btn("NEXT").click();
    assert.match(t.text(), /email\?/);
    t.env.close();
  });
  test("單選題已經有答案（從後面回來）：點別的選項只換選取、不自動跳，要自己按下一題；跳題變化會反映在按鈕與題數", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    t.qa(".opt")[1].click(); // 第一次作答 rarely：自動到最後一頁
    assert.match(t.text(), /email\?/);
    t.btn("BACK").click();
    assert.match(t.text(), /freq\?/);
    t.qa(".opt")[0].click(); // 改成 often：不跳
    assert.match(t.text(), /freq\?/);
    assert.ok(t.qa(".opt")[0].classList.contains("on"));
    assert.ok(!t.qa(".opt")[1].classList.contains("on"));
    assert.equal(t.q(".prog .count").textContent, "2/4", "often 讓 q_what 出現");
    assert.deepEqual(t.log.answers.at(-1), { q_devices: ["pc"], q_freq: "often" });
    t.btn("NEXT").click();
    assert.match(t.text(), /what\?/);
    t.env.close();
  });
  test("接著填草稿時停在已經答過的單選題（之後的題目沒答）也不會一點就跳", () => {
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "often" } }); // 停在 q_what（沒答）
    t.btn("BACK").click();
    t.qa(".opt")[1].click();
    assert.match(t.text(), /freq\?/);
    assert.equal(t.btn("SUBMIT") ? "submit" : t.btn("NEXT").textContent, "NEXT");
    t.env.close();
  });
  test("接著填草稿、直接停在最後一頁時，上一題也能往回", () => {
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
    assert.match(t.text(), /email\?/);
    assert.equal(t.q(".prog .count").textContent, "3/3");
    t.btn("BACK").click();
    assert.match(t.text(), /freq\?/);
    assert.ok(t.qa(".opt")[1].classList.contains("on"));
    t.env.close();
  });
  test("上一題回到前一頁，並保留已選的答案", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    assert.equal(t.btn("BACK").style.visibility, "");
    t.btn("BACK").click();
    assert.match(t.text(), /devices\?/);
    assert.ok(t.qa(".opt")[0].classList.contains("on"));
    t.env.close();
  });
  test("回頭改答案後，已經看不到的題目答案丟掉（送出時不帶）", async () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    t.qa(".opt")[0].click(); // often → q_what
    t.qa(".opt")[0].click(); t.btn("NEXT").click(); // q_what = anime → 最後一頁
    t.btn("BACK").click(); t.btn("BACK").click(); // 回到 q_freq
    t.qa(".opt")[1].click(); // rarely：q_what 不再成立（已經有答案，不會自動跳）
    t.btn("NEXT").click();
    t.btn("SKIP").click();
    await t.env.settle();
    assert.deepEqual(t.log.submits[0].a, { q_devices: ["pc"], q_freq: "rarely" });
    t.env.close();
  });
  test("最後一頁：兩題選填放同一頁；不填顯示「略過並送出」，填了變「送出」", () => {
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } }); // 草稿：直接停在最後一頁
    assert.ok(t.btn("SKIP"));
    assert.equal(t.qa(".field").length, 2);
    const email = t.q("input[type=email]");
    email.value = "a@b.co";
    email.dispatchEvent(new t.env.window.Event("input"));
    assert.ok(t.btn("SUBMIT"));
    assert.equal(t.q("textarea").maxLength, 500);
    t.env.close();
  });
  test("送出：onSubmit 收到答案（空白的選填題不帶）→ 打勾動畫＋謝謝、沒有關閉按鈕 → 播完自動關（不算使用者關掉）", async () => {
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
    t.q("input[type=email]").value = "  a@b.co ";
    t.q("input[type=email]").dispatchEvent(new t.env.window.Event("input"));
    t.btn("SUBMIT").click();
    await t.env.settle();
    assert.deepEqual(t.log.submits[0].a, { q_devices: ["pc"], q_freq: "rarely", q_email: "a@b.co" });
    assert.match(t.text(), /THANKS/);
    assert.ok(t.q(".okmark .ring") && t.q(".okmark .tick"), "打勾動畫");
    assert.equal(t.btn("CLOSE"), undefined, "沒有關閉按鈕");
    assert.equal(t.qa(".btn").length, 0);
    assert.equal(t.q(".prog").style.display, "none", "沒有進度點點");
    assert.doesNotMatch(t.text(), /PROMPT/, "不再畫邀請的說明文字");
    const SUCCESS_MS = t.env.window.BBSurveyUI.SUCCESS_MS;
    assert.ok(SUCCESS_MS >= 1200 && SUCCESS_MS <= 1500);
    assert.equal(t.log.closed, 0, "動畫播完前還沒關");
    t.fire(SUCCESS_MS - 250);
    assert.ok(t.q(".ov").classList.contains("out"), "最後淡出");
    t.fire(SUCCESS_MS);
    assert.equal(t.hosts(), 0);
    assert.equal(t.log.closed, 1);
    assert.equal(t.log.infos[0].byUser, false);
    assert.equal(t.timers.size, 0);
    t.env.close();
  });
  test("成功動畫上按 × 或 Esc：提早關掉，不算使用者關掉問卷，也不顯示關掉後的提示", async () => {
    for (const how of ["x", "esc"]) {
      const t = bootUi();
      t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
      t.btn("SKIP").click();
      await t.env.settle();
      assert.match(t.text(), /THANKS/);
      if (how === "x") t.q(".x").click(); else t.esc();
      assert.equal(t.hosts(), 0, how);
      assert.deepEqual(t.log.infos.map((i) => i.byUser), [false], how);
      assert.equal(t.timers.size, 0, "計時器清掉");
      t.env.close();
    }
  });
  test("減少動態：CSS 有 prefers-reduced-motion，直接顯示打勾（一樣自動關）", () => {
    const { env } = bootUi();
    const css = env.window.BBSurveyUI.CSS;
    const rm = css.slice(css.lastIndexOf("@media (prefers-reduced-motion:reduce)"));
    assert.match(rm, /\.okmark \.ring\{stroke-dashoffset:0;fill-opacity:1\}/);
    assert.match(rm, /\.okmark \.tick\{stroke-dashoffset:0\}/);
    assert.match(rm, /animation:none/);
    env.close();
  });
  test("送出失敗：顯示錯誤、按鈕可再按，不顯示謝謝", async () => {
    const t = bootUi({ submitResult: { ok: false } });
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
    t.btn("SKIP").click();
    await t.env.settle();
    assert.match(t.text(), /FAIL/);
    assert.doesNotMatch(t.text(), /THANKS/);
    assert.equal(t.btn("SKIP").disabled, false);
    t.env.close();
  });
  test("Firefox 的匿名統計勾選：只有 showConsent 才出現，勾了送出時帶 telemetryConsent", async () => {
    const a = bootUi();
    a.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
    assert.equal(a.qa("input[type=checkbox]").length, 0);
    a.env.close();
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" }, showConsent: true });
    const cb = t.q("input[type=checkbox]");
    cb.checked = true;
    cb.dispatchEvent(new t.env.window.Event("change"));
    t.btn("SKIP").click();
    await t.env.settle();
    assert.equal(t.log.submits[0].e.telemetryConsent, true);
    t.env.close();
  });
  test("Esc 與 × 關閉：立刻記下關掉一次，畫面換成「不會再出現」的提示；點遮罩不關閉", () => {
    const t = bootUi();
    t.open();
    t.q(".ov").click();
    assert.ok(t.env.document.querySelector("[data-bb-survey]"), "點遮罩不關");
    t.esc();
    assert.equal(t.log.closed, 1, "Esc：onClose 立刻呼叫");
    assert.deepEqual(plain(t.log.infos[0]), { byUser: true, page: 1 });
    assert.match(t.text(), /GONE/);
    t.fire(t.env.window.BBSurveyUI.CLOSED_NOTICE_MS);
    assert.equal(t.hosts(), 0);
    t.open();
    t.q(".x").click();
    assert.equal(t.log.closed, 2);
    assert.equal(t.log.infos[1].byUser, true);
    assert.match(t.text(), /GONE/);
    t.env.close();
  });
  test("關掉後的提示：沒有按鈕與進度點點、8 秒後自動消失，不再呼叫 onClose", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click(); // 到第 2 頁
    t.q(".x").click();
    assert.deepEqual(plain(t.log.infos), [{ byUser: true, page: 2 }]);
    assert.equal(t.q(".msg").textContent, "GONE");
    assert.equal(t.qa(".btn").length, 0, "沒有「關閉」按鈕");
    assert.equal(t.qa(".opt").length, 0);
    assert.ok(t.q(".x"), "右上角 × 還在");
    assert.equal(t.q(".prog").style.display, "none", "沒有進度點點");
    assert.doesNotMatch(t.text(), /PROMPT/);
    const ms = t.env.window.BBSurveyUI.CLOSED_NOTICE_MS;
    assert.equal(ms, 8000);
    assert.equal(t.fire(ms - 250), 1, "最後淡出");
    assert.ok(t.hosts(), "淡出時還在");
    assert.equal(t.fire(ms), 1);
    assert.equal(t.hosts(), 0, "8 秒後自動消失");
    assert.equal(t.log.closed, 1, "提示消失不算第二次關掉");
    t.env.close();
  });
  test("關掉後的提示上按 × 或 Esc：馬上消失，不會再記一次關掉；計時器清掉", () => {
    for (const how of ["x", "esc"]) {
      const t = bootUi();
      t.open();
      t.esc();
      assert.match(t.text(), /GONE/);
      if (how === "x") t.q(".x").click(); else t.esc();
      assert.equal(t.hosts(), 0, how);
      assert.equal(t.log.closed, 1, how);
      assert.equal(t.timers.size, 0, how);
      t.fire(t.env.window.BBSurveyUI.CLOSED_NOTICE_MS);
      assert.equal(t.log.closed, 1);
      t.env.close();
    }
  });
  test("關掉後的提示還在時又打開問卷（例如從公告找回）：提示先收掉，不疊兩層", () => {
    const t = bootUi();
    t.open();
    t.esc();
    assert.equal(t.hosts(), 1);
    t.open();
    assert.equal(t.hosts(), 1);
    assert.match(t.text(), /devices\?/);
    assert.equal(t.log.closed, 1, "收掉提示不算再關一次");
    t.env.close();
  });
  test("問卷已經結束的畫面上按 × 或 Esc：直接關，不顯示關掉後的提示", () => {
    for (const o of [{ ended: true }]) {
      const t = bootUi();
      t.open({ ...o, def: { questions: [] } });
      t.esc();
      assert.equal(t.hosts(), 0);
      assert.deepEqual(t.log.infos.map((i) => i.byUser), [false]);
      t.env.close();
    }
  });
  test("在輸入框打字不會傳到 B 站的快捷鍵（keydown 在 host 就攔下）", () => {
    const t = bootUi();
    t.open({ answers: { q_devices: ["pc"], q_freq: "rarely" } });
    let seen = 0;
    t.env.document.addEventListener("keydown", () => { seen++; });
    t.q("textarea").dispatchEvent(new t.env.window.KeyboardEvent("keydown", { key: "f", bubbles: true, composed: true }));
    assert.equal(seen, 0);
    t.env.close();
  });
  test("pagesOf：尾端連續的 email／text 併成最後一頁", () => {
    const { env } = bootUi();
    const pages = plain(env.window.BBSurveyUI.pagesOf(DEF, { q_freq: "rarely" }));
    assert.deepEqual(pages.map((p) => p.map((x) => x.id)), [["q_devices"], ["q_freq"], ["q_email", "q_feature"]]);
    env.close();
  });
  // 各種題型（評分、推薦分數、數字、排序、中間的長文字、複選上限）
  const TYPES_DEF = {
    id: "types", title: L("T"), questions: [
      { id: "q_rate", type: "rating", required: true, showIf: null, text: L("rate?"), scale: { style: "star", labels: { low: L("bad"), high: L("good") } } },
      { id: "q_rate_n", type: "rating", required: false, showIf: null, text: L("rate n?"), scale: { style: "number" } },
      { id: "q_nps", type: "nps", required: true, showIf: null, text: L("nps?"), labels: { low: L("never"), high: L("surely") } },
      { id: "q_hours", type: "number", required: true, showIf: null, text: L("hours?"), range: { min: 0, max: 10, step: 0.5, unit: L("h") } },
      { id: "q_rank", type: "rank", required: true, showIf: null, text: L("rank?"), options: opts("r1", "r2", "r3") },
      { id: "q_story", type: "longtext", required: true, showIf: null, text: L("story?") },
      { id: "q_two", type: "multi", required: true, showIf: null, text: L("two?"), options: opts("m1", "m2", "m3"), maxSelect: 2 },
      { id: "q_email", type: "email", required: false, showIf: null, text: L("email?") }
    ]
  };
  test("評分（星星）：第一次點了就進下一題；兩端說明；回頭看時點別的分數不自動跳", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF });
    assert.equal(t.qa(".scale.stars .star").length, 5);
    assert.match(t.q(".ends").textContent, /bad.*good/);
    assert.equal(t.btn("NEXT").disabled, true, "必答還沒選");
    t.qa(".star")[3].click(); // 4 分
    assert.match(t.text(), /rate n\?/);
    assert.deepEqual(t.log.answers.at(-1), { q_rate: 4 });
    t.btn("BACK").click();
    assert.equal(t.qa(".star.on").length, 4);
    t.qa(".star")[1].click();
    assert.match(t.text(), /rate\?/, "已經有答案，不自動跳");
    assert.equal(t.qa(".star.on").length, 2);
    t.env.close();
  });
  test("評分（數字）是 1–5 五個按鈕、選填可以直接下一題；推薦分數是 0–10 十一個按鈕", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF, answers: { q_rate: 3 } });
    assert.match(t.text(), /rate n\?/);
    assert.deepEqual(t.qa(".sc").map((b) => b.textContent), ["1", "2", "3", "4", "5"]);
    assert.equal(t.btn("NEXT").disabled, false, "選填");
    t.btn("NEXT").click();
    assert.deepEqual(t.qa(".scale.nps .sc").map((b) => b.textContent), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    assert.match(t.q(".ends").textContent, /never.*surely/);
    t.qa(".sc")[0].click(); // 0 分也是答案
    assert.match(t.text(), /hours\?/);
    assert.equal(t.log.answers.at(-1).q_nps, 0);
    t.env.close();
  });
  test("數字：範圍與間隔不對時不能按下一題；單位顯示在旁邊", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF, answers: { q_rate: 3, q_nps: 9 } });
    assert.match(t.text(), /hours\?/);
    assert.equal(t.q(".unit").textContent, "h");
    const inp = t.q("input[type=number]");
    const type = (v) => { inp.value = v; inp.dispatchEvent(new t.env.window.Event("input")); };
    assert.equal(t.btn("NEXT").disabled, true);
    type("11"); assert.equal(t.btn("NEXT").disabled, true, "超過最大值");
    type("1.2"); assert.equal(t.btn("NEXT").disabled, true, "不符合 0.5 的間隔");
    type("2.5"); assert.equal(t.btn("NEXT").disabled, false);
    t.btn("NEXT").click();
    assert.equal(t.log.answers.at(-1).q_hours, 2.5);
    t.env.close();
  });
  test("排序：上移／下移改順序，按下一題時把目前的順序當答案", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF, answers: { q_rate: 3, q_nps: 9, q_hours: 1 } });
    assert.match(t.text(), /rank\?/);
    const items = () => t.qa(".ritem .rtext").map((x) => x.textContent);
    assert.deepEqual(items(), ["r1", "r2", "r3"]);
    assert.equal(t.qa(".rbtn")[0].disabled, true, "第一個不能再上移");
    t.qa(".ritem")[2].querySelectorAll(".rbtn")[0].click(); // r3 上移
    assert.deepEqual(items(), ["r1", "r3", "r2"]);
    t.qa(".ritem")[0].querySelectorAll(".rbtn")[1].click(); // r1 下移
    assert.deepEqual(items(), ["r3", "r1", "r2"]);
    t.btn("NEXT").click();
    assert.deepEqual(t.log.answers.at(-1).q_rank, ["r3", "r1", "r2"]);
    t.env.close();
  });
  test("中間的長文字題自成一頁：必答沒填不能下一題", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF, answers: { q_rate: 3, q_nps: 9, q_hours: 1, q_rank: ["r1", "r2", "r3"] } });
    assert.match(t.text(), /story\?/);
    assert.equal(t.btn("NEXT").disabled, true);
    const ta = t.q("textarea");
    ta.value = "  long story  "; ta.dispatchEvent(new t.env.window.Event("input"));
    assert.equal(t.btn("NEXT").disabled, false);
    t.btn("NEXT").click();
    assert.equal(t.log.answers.at(-1).q_story, "long story");
    assert.match(t.text(), /two\?/);
    t.env.close();
  });
  test("複選上限：選滿時其他選項不能按，取消一個就恢復", () => {
    const t = bootUi();
    t.open({ def: TYPES_DEF, answers: { q_rate: 3, q_nps: 9, q_hours: 1, q_rank: ["r1", "r2", "r3"], q_story: "x" } });
    assert.match(t.text(), /two\?/);
    t.qa(".opt")[0].click(); t.qa(".opt")[1].click();
    assert.equal(t.qa(".opt")[2].disabled, true);
    t.qa(".opt")[0].click();
    assert.equal(t.qa(".opt")[2].disabled, false);
    t.env.close();
  });
  test("選項順序照背景決定的 order（隨機排序的題目）；order 對不上就用原順序", () => {
    const t = bootUi();
    t.open({ order: { q_devices: ["phone", "pc"] } });
    assert.deepEqual(t.qa(".opt").map((b) => b.textContent), ["phone", "pc"]);
    t.env.close();
    const u = bootUi();
    u.open({ order: { q_devices: ["phone", "nope"] } });
    assert.deepEqual(u.qa(".opt").map((b) => b.textContent), ["pc", "phone"]);
    u.env.close();
  });
  test("問卷已經結束：只顯示一句話和關閉；關閉不算使用者關掉問卷", () => {
    const t = bootUi();
    let info = null;
    t.open({ ended: true, def: { questions: [] }, ui: { ...UI, ended: "ENDED" }, onClose: (i) => { info = i; } });
    assert.match(t.text(), /ENDED/);
    t.btn("CLOSE").click();
    assert.equal(info.byUser, false);
    t.env.close();
  });
  test("pagesOf：inline 的說明題不自成一頁（選了其他也一樣）", () => {
    const { env } = bootUi();
    const pages = plain(env.window.BBSurveyUI.pagesOf(DEF, { q_freq: "often", q_what: ["other"] }));
    assert.deepEqual(pages.map((p) => p.map((x) => x.id)), [["q_devices"], ["q_freq"], ["q_what"], ["q_email", "q_feature"]]);
    env.close();
  });
  test("複選題選了「其他」：下面出現選填說明框；填了跟著答案送；取消「其他」說明框收起、說明不送", () => {
    const t = bootUi();
    t.open();
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    t.qa(".opt")[0].click(); // often → q_what
    assert.match(t.text(), /what\?/);
    const box = () => t.q(".field.inline");
    assert.ok(box(), "說明框先畫好");
    assert.equal(box().hidden, true, "還沒選其他時收起來");
    t.qa(".opt")[2].click(); // 其他
    assert.equal(box().hidden, false);
    assert.match(box().textContent, /other detail\?/);
    assert.equal(t.env.document.querySelector("[data-bb-survey]").shadowRoot.activeElement, box().querySelector("textarea"), "游標放進說明框");
    const ta = box().querySelector("textarea");
    assert.equal(ta.maxLength, 200);
    ta.value = "Douyin"; ta.dispatchEvent(new t.env.window.Event("input"));
    t.btn("NEXT").click();
    assert.deepEqual(t.log.answers.at(-1), { q_devices: ["pc"], q_freq: "often", q_what: ["other"], q_what_other: "Douyin" });
    assert.equal(t.q(".prog .count").textContent, "4/4", "說明框不算一頁");
    t.btn("BACK").click();
    assert.equal(box().hidden, false, "回來時照答案打開");
    assert.equal(box().querySelector("textarea").value, "Douyin");
    t.qa(".opt")[2].click(); // 取消其他
    assert.equal(box().hidden, true);
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    assert.deepEqual(t.log.answers.at(-1), { q_devices: ["pc"], q_freq: "often", q_what: ["anime"] });
    t.env.close();
  });
  test("單選題第一次作答選到會打開說明框的選項：不自動跳，留在這頁填；按下一題才走", () => {
    const t = bootUi();
    const def = JSON.parse(JSON.stringify(DEF));
    def.questions[1].options.push({ id: "elsewise", text: L("elsewise") });
    def.questions.splice(2, 0, { id: "q_freq_other", type: "text", required: false, inline: true, maxLength: 200, showIf: { q: "q_freq", in: ["elsewise"] }, text: L("freq detail?") });
    t.open({ def });
    t.qa(".opt")[0].click(); t.btn("NEXT").click();
    t.qa(".opt")[2].click(); // elsewise
    assert.match(t.text(), /freq\?/);
    assert.equal(t.q(".field.inline").hidden, false);
    assert.equal(t.btn("NEXT").disabled, false);
    t.btn("NEXT").click();
    assert.match(t.text(), /email\?/);
    t.env.close();
  });

  // 流程圖：複選的出口第一條符合的勝出、出口指到 end、上一題照實際走過的路、換路後舊路的答案不送
  const FLOW = {
    id: "flow", title: L("FLOW"), weight: 1, minExtVersion: "2.10.1", prompt: { invite: L("INVITE") }, triggers: { invite: true, events: [] },
    questions: [
      { id: "f_m", type: "multi", required: true, text: L("m?"), options: opts("a", "b", "c"),
        next: { rules: [{ in: ["a", "b"], to: "f_x" }, { in: ["c"], to: "f_y" }], else: "f_end" } },
      { id: "f_x", type: "single", required: true, text: L("x?"), options: opts("stop", "go"), next: { rules: [{ in: ["stop"], to: "end" }], else: "f_y" } },
      { id: "f_y", type: "rating", required: true, text: L("y?"), next: { else: "f_end" } },
      { id: "f_end", type: "longtext", required: false, text: L("end?") },
    ],
  };
  test("流程圖：複選依出口順序分岔（勾 b、c 走第一條）；總題數跟著答案變", () => {
    const t = bootUi();
    t.open({ def: FLOW });
    assert.equal(t.q(".prog .count").textContent, "1/2", "還沒勾：照其他情況算");
    t.qa(".opt")[2].click(); // c → f_y
    assert.equal(t.q(".prog .count").textContent, "1/3");
    t.qa(".opt")[1].click(); // b、c 都勾：第一條（a、b → f_x）勝出
    assert.equal(t.q(".prog .count").textContent, "1/4");
    t.btn("NEXT").click();
    assert.match(t.text(), /x\?/);
    t.env.close();
  });
  test("流程圖：出口指到結束時這頁就是最後一頁（單選第一次作答直接送出）", async () => {
    const t = bootUi();
    t.open({ def: FLOW });
    t.qa(".opt")[0].click(); t.btn("NEXT").click(); // a → f_x
    t.qa(".opt")[0].click(); // stop → 結束
    await t.env.settle();
    assert.deepEqual(t.log.submits[0].a, { f_m: ["a"], f_x: "stop" });
    t.env.close();
  });
  test("流程圖：上一題照實際走過的路退回；改答案換路後，原本那條路上的答案不送出", async () => {
    const t = bootUi();
    t.open({ def: FLOW });
    t.qa(".opt")[0].click(); t.btn("NEXT").click(); // a → f_x
    t.qa(".opt")[1].click(); // go → f_y
    assert.match(t.text(), /y\?/);
    t.qa(".star")[3].click(); // 4 分 → f_end
    assert.match(t.text(), /end\?/);
    t.btn("BACK").click();
    assert.match(t.text(), /y\?/);
    t.btn("BACK").click();
    assert.match(t.text(), /x\?/, "退回走過的 f_x，不是陣列裡的前一題");
    t.btn("BACK").click();
    assert.match(t.text(), /m\?/);
    t.qa(".opt")[0].click(); // 取消 a
    t.qa(".opt")[2].click(); // 改勾 c → 直接到 f_y，不經過 f_x
    assert.equal(t.q(".prog .count").textContent, "1/3");
    t.btn("NEXT").click();
    assert.match(t.text(), /y\?/);
    t.btn("BACK").click();
    assert.match(t.text(), /m\?/, "f_y 的上一題是 f_m（這條路沒有 f_x）");
    t.btn("NEXT").click();
    t.btn("NEXT").click(); // f_y 已經有答案（4 分），按下一題
    t.btn("SKIP").click();
    await t.env.settle();
    assert.deepEqual(t.log.submits[0].a, { f_m: ["c"], f_y: 4 }, "f_x 在舊路上：不送");
    assert.ok(t.log.answers.every((a) => !(a.f_m && a.f_m.includes("c") && "f_x" in a)), "換路之後的每一次草稿也不帶 f_x");
    t.env.close();
  });
});

// ---------------------------------------------------------------------------------------------
// survey-page.js（觸發時機、心跳計時、公告 hash）
// ---------------------------------------------------------------------------------------------
function bootPage({ url = "https://www.bilibili.com/", storage = {}, begin, now = 1_800_000_000_000 } = {}) {
  const env = createEnv({ url, storage });
  const timers = new Map();
  let n = 0;
  env.window.setTimeout = (fn, ms) => { timers.set(++n, { fn, ms }); return n; };
  env.window.clearTimeout = (id) => { timers.delete(id); };
  let clock = now;
  env.window.Date.now = () => clock;
  const begins = [], beginMsgs = [];
  env.chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "BB_SURVEY_BEGIN") {
      begins.push(msg.entry);
      beginMsgs.push(msg);
      respond(begin ? begin(msg) : { ok: true, def: DEF, answers: {}, responseId: "r".repeat(32), firefox: false, needTelemetryConsent: false });
      return true;
    }
  });
  env.load("survey-core.js").load("survey-ui.js").load("survey-page.js");
  const P = env.internals("survey-page");
  const find = (ms) => Array.from(timers.entries()).filter(([, t]) => t.ms === ms);
  const fire = (ms) => { const hit = find(ms); hit.forEach(([id, t]) => { timers.delete(id); t.fn(); }); return hit.length; };
  const state = (st) => env.postMessage({ __cdnSwitcher: 1, dir: "video-state", payload: { state: st } });
  const sent = (type) => env.runtimeMessages.filter((m) => m.type === type);
  return { env, P, timers, find, fire, state, begins, beginMsgs, sent, setNow: (v) => { clock = v; }, now };
}

describe("survey-page.js：頁面邀請的時機", () => {
  test("首頁、還沒播過影片：約 5 秒後出現（頁面邀請）", async () => {
    const t = bootPage();
    assert.equal(t.find(5000).length, 1);
    t.fire(5000);
    await t.env.settle();
    assert.deepEqual(t.begins, ["invite"]);
    assert.ok(t.env.document.querySelector("[data-bb-survey]"));
    assert.match(t.env.document.querySelector("[data-bb-survey]").shadowRoot.textContent, /INVITE/);
    t.env.close();
  });
  test("海外被導到的語言路徑（/zh-Hant、/en）也是首頁；影片頁、番劇頁、分類頁不是", () => {
    for (const [path, want] of [["/", true], ["/index.html", true], ["/zh-Hant", true], ["/zh-Hant/", true], ["/en", true], ["/video/BV1xx", false], ["/bangumi/play/ep1", false], ["/anime", false], ["/v/game", false]]) {
      const t = bootPage({ url: "https://www.bilibili.com" + path });
      assert.equal(t.P.isHome(), want, path);
      t.env.close();
    }
    const other = bootPage({ url: "https://space.bilibili.com/" });
    assert.equal(other.P.isHome(), false, "只有 www.bilibili.com");
    other.env.close();
  });
  test("不是首頁就不用 5 秒計時", () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    assert.equal(t.find(5000).length, 0);
    t.env.close();
  });
  test("這個分頁已經播過影片：不出現", async () => {
    const t = bootPage();
    t.state("playing");
    assert.equal(t.find(5000).length, 0, "播放就取消計時");
    t.state("none");
    t.fire(5000);
    await t.env.settle();
    assert.deepEqual(t.begins, []);
    t.env.close();
  });
  test("影片播完（ended）10 秒內沒開始下一部：出現", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    t.state("playing");
    t.state("ended");
    assert.equal(t.find(10000).length, 1);
    t.fire(10000);
    await t.env.settle();
    assert.deepEqual(t.begins, ["invite"]);
    t.env.close();
  });
  test("影片播完後 10 秒內開始下一部（自動連播）：取消", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    t.state("ended");
    t.state("playing");
    assert.equal(t.find(10000).length, 0);
    t.env.close();
  });
  test("暫停中不出現", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    t.state("ended");
    const [[id, tm]] = t.find(10000);
    t.state("paused");
    assert.equal(t.find(10000).length, 0);
    tm.fn(); // 就算計時器還是被觸發了，狀態不是 ended 也不出現
    await t.env.settle();
    assert.deepEqual(t.begins, []);
    t.env.close();
  });
  test("全螢幕、分頁在背景時不出現", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    t.state("ended");
    Object.defineProperty(t.env.document, "fullscreenElement", { value: t.env.document.body, configurable: true });
    t.fire(10000);
    await t.env.settle();
    assert.deepEqual(t.begins, []);
    t.env.close();
    const u = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    u.state("ended");
    Object.defineProperty(u.env.document, "visibilityState", { value: "hidden", configurable: true });
    u.fire(10000);
    await u.env.settle();
    assert.deepEqual(u.begins, []);
    u.env.close();
  });
  test("背景說不能顯示（已邀請過、開關關閉等）：什麼都不出現", async () => {
    const t = bootPage({ begin: () => ({ ok: false, reason: "invited" }) });
    t.fire(5000);
    await t.env.settle();
    assert.deepEqual(t.begins, ["invite"]);
    assert.equal(t.env.document.querySelector("[data-bb-survey]"), null);
    t.env.close();
  });
  test("正在顯示時不會再開第二個", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    t.state("ended"); t.fire(10000); await t.env.settle();
    t.state("playing"); t.state("ended"); t.fire(10000); await t.env.settle();
    assert.equal(t.begins.length, 1);
    assert.equal(t.env.document.querySelectorAll("[data-bb-survey]").length, 1);
    t.env.close();
  });
});

describe("survey-page.js：遇到地區限定", () => {
  test("main-hook 報 region-blocked → 請背景計數，並觸發事件 region_blocked（說明文字用該事件的）", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/bangumi/play/ep1" });
    t.env.postMessage({ __cdnSwitcher: 1, dir: "region-blocked", payload: {} });
    await t.env.settle();
    assert.equal(t.sent("BB_TELEMETRY_BLOCKED").length, 1);
    assert.deepEqual(t.begins, ["region_blocked"]);
    assert.match(t.env.document.querySelector("[data-bb-survey]").shadowRoot.textContent, /EVENT/);
    t.env.close();
  });
  test("問卷不能顯示時，計數照送", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/bangumi/play/ep1", begin: () => ({ ok: false, reason: "unavailable" }) });
    t.env.postMessage({ __cdnSwitcher: 1, dir: "region-blocked", payload: {} });
    await t.env.settle();
    assert.equal(t.sent("BB_TELEMETRY_BLOCKED").length, 1);
    assert.equal(t.env.document.querySelector("[data-bb-survey]"), null);
    t.env.close();
  });
});

describe("survey-page.js：抽樣播放心跳（整 5 分鐘取樣）", () => {
  const SLOT = 300000;
  const aligned = 1_800_000_000_000 - (1_800_000_000_000 % SLOT); // 整 5 分鐘
  function slotTimer(t) { return Array.from(t.timers.values()).find((x) => x.ms > 1000 && x.ms <= SLOT + 1000 && x.ms !== 5000 && x.ms !== 10000); }

  test("下一個整 5 分鐘的時刻播放中 → 送一次；之後再排下一個", () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx", now: aligned + 100_000 });
    const tm = slotTimer(t);
    assert.equal(tm.ms, SLOT - 100_000, "對準下一個整 5 分鐘");
    t.state("playing");
    t.setNow(aligned + SLOT);
    t.timers.clear();
    tm.fn();
    return t.env.settle().then(() => {
      assert.equal(t.sent("BB_TELEMETRY_HEARTBEAT").length, 1);
      assert.ok(slotTimer(t), "再排下一個");
      t.env.close();
    });
  });
  test("暫停、沒在播、已播完的分頁不送", async () => {
    for (const st of ["paused", "none", "ended"]) {
      const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx", now: aligned + 100_000 });
      const tm = slotTimer(t);
      t.state(st);
      t.setNow(aligned + SLOT);
      tm.fn();
      await t.env.settle();
      assert.equal(t.sent("BB_TELEMETRY_HEARTBEAT").length, 0, st);
      t.env.close();
    }
  });
  test("計時器被延遲太久（睡眠、背景分頁）就跳過這一次，不然取樣時刻對不上", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx", now: aligned + 100_000 });
    const tm = slotTimer(t);
    t.state("playing");
    t.setNow(aligned + SLOT + 2 * 60_000);
    tm.fn();
    await t.env.settle();
    assert.equal(t.sent("BB_TELEMETRY_HEARTBEAT").length, 0);
    t.env.close();
  });
  test("已知沒被抽中（telemetrySample=false）：不叫醒背景", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx", now: aligned + 100_000, storage: { telemetrySample: false } });
    const tm = slotTimer(t);
    t.state("playing");
    t.setNow(aligned + SLOT);
    tm.fn();
    await t.env.settle();
    assert.equal(t.sent("BB_TELEMETRY_HEARTBEAT").length, 0);
    t.env.close();
  });
});

describe("survey-page.js：公告連結與 console", () => {
  test("網址帶 #bb-survey=<問卷 id>：拿掉 hash、用 announcement 入口打開那一份；結尾 &console 是 console 開的", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey=sample-a" });
    await t.env.settle();
    assert.deepEqual(plain(t.beginMsgs.map((m) => [m.entry, m.surveyId, m.lang])), [["announcement", "sample-a", "en"]]);
    assert.equal(t.env.window.location.hash, "");
    t.env.close();
    const u = bootPage({ url: "https://www.bilibili.com/#bb-survey=sample-a&console" });
    await u.env.settle();
    assert.deepEqual(plain(u.beginMsgs.map((m) => [m.entry, m.surveyId])), [["console", "sample-a"]]);
    u.env.close();
    const v = bootPage({ url: "https://www.bilibili.com/#bb-survey=Bad_ID" });
    await v.env.settle();
    assert.deepEqual(v.begins, [], "格式不對的 hash 不理");
    v.env.close();
  });
  test("網址帶 #bb-survey：拿掉 hash、用 announcement 入口打開", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey" });
    await t.env.settle();
    assert.deepEqual(t.begins, ["announcement"]);
    assert.equal(t.env.window.location.hash, "");
    assert.ok(t.env.document.querySelector("[data-bb-survey]"));
    t.env.close();
  });
  test("背景傳 BB_SURVEY_SHOW（目前分頁就是 B 站）：直接打開", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/video/BV1xx" });
    let resp;
    t.env.chrome.runtime.sendMessage({ type: "BB_SURVEY_SHOW", surveyId: "sample-a", entry: "console" }, (r) => { resp = r; });
    await t.env.settle();
    assert.deepEqual(plain(resp), { ok: true });
    assert.deepEqual(plain(t.beginMsgs.map((m) => [m.entry, m.surveyId])), [["console", "sample-a"]]);
    t.env.close();
  });
  test("從公告打開已經結束的問卷：顯示「已經結束」；自動觸發沒有問卷時不出聲", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey=sample-a", begin: () => ({ ok: false, reason: "ended" }) });
    await t.env.settle();
    assert.match(t.env.document.querySelector("[data-bb-survey]").shadowRoot.textContent, /ended/);
    t.env.close();
    const u = bootPage({ begin: () => ({ ok: false, reason: "ended" }) });
    u.fire(5000);
    await u.env.settle();
    assert.equal(u.env.document.querySelector("[data-bb-survey]"), null);
    u.env.close();
  });
  test("換頁回報停留時間；使用者按 × 才回報關掉（第幾頁）", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey" });
    await t.env.settle();
    const root = t.env.document.querySelector("[data-bb-survey]").shadowRoot;
    root.querySelectorAll(".opt")[0].click();
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Next").click();
    await t.env.settle();
    const page = t.sent("BB_SURVEY_PAGE")[0];
    assert.deepEqual([page.surveyId, page.page, page.question, page.entry], ["sample-a", 1, "q_devices", "announcement"]);
    assert.equal(typeof page.ms, "number");
    root.querySelector(".x").click();
    await t.env.settle();
    assert.deepEqual(plain(t.sent("BB_SURVEY_CLOSED").map((c) => [c.surveyId, c.page])), [["sample-a", 2]]);
    assert.equal(t.sent("BB_SURVEY_PAGE").length, 2, "關掉時也回報最後一頁的停留時間");
    // 關掉後的提示（擴充的文案），8 秒後自動消失；提示消失不會再送一次關掉
    assert.match(root.querySelector(".msg").textContent, /won't show up again/);
    assert.equal(t.P.isOpen(), false, "已經記下關掉：頁面可以再打開別的問卷");
    assert.equal(t.fire(8000), 1);
    await t.env.settle();
    assert.equal(t.env.document.querySelector("[data-bb-survey]"), null);
    assert.equal(t.sent("BB_SURVEY_CLOSED").length, 1);
    t.env.close();
  });
  test("問卷開著時頁面關掉（pagehide）或切到背景（visibilitychange → hidden）：請背景立刻送出事件；沒開問卷時不叫醒背景", async () => {
    const idle = bootPage();
    idle.env.window.dispatchEvent(new idle.env.window.Event("pagehide"));
    assert.equal(idle.sent("BB_SURVEY_FLUSH").length, 0);
    idle.env.close();
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey" });
    await t.env.settle();
    assert.equal(t.P.isOpen(), true);
    t.env.window.dispatchEvent(new t.env.window.Event("pagehide"));
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 1);
    t.env.document.dispatchEvent(new t.env.window.Event("visibilitychange"));
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 1, "還是 visible：不送");
    Object.defineProperty(t.env.document, "visibilityState", { value: "hidden", configurable: true });
    t.env.document.dispatchEvent(new t.env.window.Event("visibilitychange"));
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 2);
    t.env.close();
  });
  test("背景回其他原因（例如舊版背景回 done）：公告入口不出聲，只有 ended 才顯示「已經結束」", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey", begin: () => ({ ok: false, reason: "done" }) });
    await t.env.settle();
    assert.equal(t.env.document.querySelector("[data-bb-survey]"), null);
    t.env.close();
  });
  test("每答一題送一次（依序）；最後送出帶 final", async () => {
    const t = bootPage({ url: "https://www.bilibili.com/#bb-survey" });
    await t.env.settle();
    const root = t.env.document.querySelector("[data-bb-survey]").shadowRoot;
    root.querySelectorAll(".opt")[0].click();
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Next").click();
    root.querySelectorAll(".opt")[1].click(); // rarely
    await t.env.settle();
    const sends = t.sent("BB_SURVEY_SUBMIT");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].final, false);
    assert.equal(sends[0].entry, "announcement");
    assert.equal(sends[0].surveyId, "sample-a");
    assert.equal(sends[0].lang, "en");
    assert.deepEqual(plain(sends[1].answers), { q_devices: ["pc"], q_freq: "rarely" });
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Skip and submit").click();
    await t.env.settle();
    assert.equal(t.sent("BB_SURVEY_SUBMIT").at(-1).final, true);
    t.env.close();
  });
});

describe("survey-page.js：語言與介面文字", () => {
  test("popup 選的語言優先；跟隨瀏覽器時依瀏覽器語言，香港／澳門用粵語", () => {
    const t = bootPage();
    const d = t.P.detectLang;
    assert.equal(d("ja"), "ja");
    assert.equal(d("ko"), "ko");
    assert.equal(d("xx"), "en", "不是合法的語言代碼就當 auto");
    assert.equal(d("zh_CN"), "zh_CN");
    assert.equal(d("zh_HK"), "zh_HK");
    assert.equal(d("auto"), "en", "測試環境的瀏覽器語言是 en");
    t.env.close();
    for (const [ui, want] of [["ja", "ja"], ["ko-KR", "ko"], ["zh-TW", "zh_TW"], ["zh-CN", "zh_CN"], ["zh-HK", "zh_HK"], ["fr", "en"]]) {
      const env = createEnv({ url: "https://www.bilibili.com/", uiLanguage: ui });
      env.load("survey-core.js").load("survey-ui.js").load("survey-page.js");
      assert.equal(env.internals("survey-page").detectLang("auto"), want, ui);
      env.close();
    }
  });
  test("介面文字：uiMsgs 優先，沒有就用 chrome.i18n", () => {
    const t = bootPage();
    const s = t.P.uiStrings({ surveyNext: "NEXT!" });
    assert.equal(s.next, "NEXT!");
    assert.equal(s.close, "Close", "沒有覆寫就用瀏覽器語言的文案（測試環境是 en）");
    t.env.close();
  });
});

// ---------------------------------------------------------------------------------------------
// main-hook.js：大陸限定偵測與影片狀態
// ---------------------------------------------------------------------------------------------
function bootHook({ url = "https://www.bilibili.com/bangumi/play/ep1", html } = {}) {
  const env = createEnv({ url, html });
  env.window.localStorage.setItem("__CDN_SWITCHER_CFG__", JSON.stringify({ cdnHost: "upos-sz-mirror08ct.bilivideo.com" }));
  env.load("main-hook.js");
  const seen = [];
  env.window.addEventListener("message", (ev) => { if (ev.data && ev.data.__cdnSwitcher === 1) seen.push(ev.data); });
  return { env, mh: env.internals("main-hook"), seen };
}

describe("main-hook.js：遇到大陸限定（playurl 回 -10403）", () => {
  test("番劇 playurl 回 -10403 → 通知 bridge 一次；回應原樣交給播放器", async () => {
    const { env, seen } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: { code: -10403, message: "抱歉您所在地区不可观看！" } });
    const resp = await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1");
    assert.equal((await resp.json()).code, -10403, "播放器還拿得到完整回應");
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 1);
    env.close();
  });
  test("現在的番劇網頁播放器打 ogv/player/playview：code 0 但有 AreaLimitPanel 外掛＝地區限制（真瀏覽器實測的回應形狀）", async () => {
    const { env, seen } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: { code: 0, message: "0", ttl: 1, data: { play_video_type: "none", arc: { cid: 1 }, plugins: [{ name: "AreaLimitPanel" }] } } });
    const resp = await env.window.fetch("https://api.bilibili.com/ogv/player/playview?biz_type=ogv&scene=normal&ep_id=1");
    assert.equal((await resp.json()).data.play_video_type, "none", "播放器拿得到完整回應");
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 1);
    env.close();
  });
  test("playview 正常播放（plugins 裡沒有 AreaLimitPanel）、或不是 playview 的請求都不算", async () => {
    const { env, seen, mh } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: { code: 0, data: { play_video_type: "dash", plugins: [{ name: "Subtitle" }] } } });
    await env.window.fetch("https://api.bilibili.com/ogv/player/playview?ep_id=2");
    env.fetchHandler = () => fakeResponse({ body: { code: 0, data: { plugins: [{ name: "AreaLimitPanel" }] } } });
    await env.window.fetch("https://api.bilibili.com/ogv/player/something-else?ep_id=3");
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 0);
    assert.equal(mh.isRegionBlocked({ code: -352, data: { plugins: [{ name: "AreaLimitPanel" }] } }), false, "code 不是 0 的錯誤不算");
    assert.equal(mh.isRegionBlocked(null), false);
    assert.equal(mh.isRegionBlocked({ code: 0, data: { plugins: "x" } }), false);
    env.close();
  });
  test("頁面寫入的 __PLAYURL_HYDRATE_DATA__（2026-11 起第一集不再打 playview）：result.plugins 有 AreaLimitPanel＝地區限制；值原樣留給頁面", async () => {
    const { env, seen, mh } = bootHook();
    const data = { code: 0, message: "0", ttl: 1, result: { play_video_type: "none", arc: { cid: 1 }, plugins: [{ name: "AreaLimitPanel", config: { is_block: true } }] } };
    env.window.__PLAYURL_HYDRATE_DATA__ = data;
    assert.equal(env.window.__PLAYURL_HYDRATE_DATA__, data);
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 1);
    assert.equal(mh.isRegionBlocked({ code: 0, result: { plugins: [{ name: "Subtitle" }] } }), false);
    env.close();
  });
  test("__PLAYURL_HYDRATE_DATA__ 正常播放（沒有 AreaLimitPanel）不算", async () => {
    const { env, seen } = bootHook();
    env.window.__PLAYURL_HYDRATE_DATA__ = { code: 0, result: { play_video_type: "dash", plugins: [] } };
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 0);
    env.close();
  });
  test("main-hook 載入前頁面就寫好 __PLAYURL_HYDRATE_DATA__：直接看現有的值", async () => {
    const env = createEnv({ url: "https://www.bilibili.com/bangumi/play/ep1" });
    env.window.__PLAYURL_HYDRATE_DATA__ = { code: 0, result: { plugins: [{ name: "AreaLimitPanel" }] } };
    const seen = [];
    env.window.addEventListener("message", (ev) => { if (ev.data && ev.data.dir === "region-blocked") seen.push(1); });
    env.load("main-hook.js");
    await env.settle(30);
    assert.equal(seen.length, 1);
    env.close();
  });
  test("同一個頁面重打 playurl 不重複計", async () => {
    const { env, seen } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: { code: -10403 } });
    await env.window.fetch("https://api.bilibili.com/pgc/player/web/playurl?ep_id=1");
    await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1");
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 1);
    env.close();
  });
  test("正常的回應、其他錯誤碼、一般影片的 playurl 都不算", async () => {
    const { env, seen } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: { code: 0, result: {} } });
    await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1");
    env.fetchHandler = () => fakeResponse({ body: { code: -404 } });
    await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=2");
    env.fetchHandler = () => fakeResponse({ body: { code: -10403 } });
    await env.window.fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=1&cid=2");
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 0);
    env.close();
  });
  test("回應不是 JSON、或 fetch 失敗：不影響頁面（照樣丟出原本的結果）", async () => {
    const { env, seen } = bootHook();
    env.fetchHandler = () => fakeResponse({ body: "<html>not json</html>" });
    const resp = await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1");
    assert.equal(await resp.text(), "<html>not json</html>");
    env.fetchHandler = () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=3"), /Failed to fetch/);
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "region-blocked").length, 0);
    env.close();
  });
  test("擴充沒啟用（enabled=false）也偵測", async () => {
    const env = createEnv({ url: "https://www.bilibili.com/bangumi/play/ep1" });
    env.window.localStorage.setItem("__CDN_SWITCHER_CFG__", JSON.stringify({ cdnHost: "upos-sz-mirror08ct.bilivideo.com", enabled: false }));
    env.load("main-hook.js");
    const seen = [];
    env.window.addEventListener("message", (ev) => { if (ev.data && ev.data.dir === "region-blocked") seen.push(1); });
    env.fetchHandler = () => fakeResponse({ body: { code: -10403 } });
    await env.window.fetch("https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1");
    await env.settle(30);
    assert.equal(seen.length, 1);
    env.close();
  });
});

describe("main-hook.js：影片狀態 video-state", () => {
  const HTML = '<!doctype html><html><head></head><body><div class="bpx-player-video-area"><video id="v"></video></div><video id="preview"></video></body></html>';
  test("播放器裡的 video：paused／playing／ended；首頁預覽那種播放器外的 video 不算", async () => {
    const { env, mh, seen } = bootHook({ html: HTML, url: "https://www.bilibili.com/video/BV1xx" });
    const v = env.document.getElementById("v");
    mh.postVideoState(true);
    Object.defineProperty(v, "paused", { value: false, configurable: true });
    mh.postVideoState(false);
    Object.defineProperty(v, "ended", { value: true, configurable: true });
    mh.postVideoState(false);
    await env.settle(30);
    assert.deepEqual(seen.filter((m) => m.dir === "video-state").map((m) => m.payload.state), ["paused", "playing", "ended"]);
    env.close();
  });
  test("沒有播放器（首頁）＝ none，即使頁面上有自動播放的預覽 video", async () => {
    const { env, mh, seen } = bootHook({ html: '<!doctype html><html><body><video id="preview"></video></body></html>', url: "https://www.bilibili.com/" });
    Object.defineProperty(env.document.getElementById("preview"), "paused", { value: false, configurable: true });
    mh.postVideoState(true);
    await env.settle(30);
    assert.deepEqual(seen.filter((m) => m.dir === "video-state").map((m) => m.payload.state), ["none"]);
    env.close();
  });
  test("狀態沒變不重送（除非 force，每 10 秒補送一次）", async () => {
    const { env, mh, seen } = bootHook({ html: HTML, url: "https://www.bilibili.com/video/BV1xx" });
    mh.postVideoState(true);
    mh.postVideoState(false);
    mh.postVideoState(false);
    mh.postVideoState(true);
    await env.settle(30);
    assert.equal(seen.filter((m) => m.dir === "video-state").length, 2);
    env.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 背景的訊息路由、公告連結
// ---------------------------------------------------------------------------------------------
function bootBackground(opts = {}) {
  const env = createEnv({ url: "chrome-extension://bcs-test/background.js", ...opts });
  const listeners = [];
  const orig = env.chrome.runtime.onMessage.addListener;
  env.chrome.runtime.onMessage.addListener = (fn) => { listeners.push(fn); orig(fn); };
  bgListeners.set(env, listeners);
  env.load("cdn-list.js").load("features.js").load("cloud.js").load("survey-core.js").load("survey.js").load("background.js");
  return env;
}
// 測試用的 sendMessage 不支援非同步回應：直接呼叫背景註冊的 onMessage 處理函式
const bgListeners = new WeakMap();
function ask(env, msg) {
  return new Promise((resolve) => {
    for (const fn of bgListeners.get(env)) { if (fn(msg, { tab: null }, resolve) === true) return; }
    resolve(undefined);
  });
}

describe("background.js：問卷與統計的訊息", () => {
  test("BB_SURVEY_BEGIN／SUBMIT／PAGE／CLOSED 轉給 survey.js", async () => {
    const env = bootBackground();
    const calls = [];
    env.chrome.runtime.getContexts = () => Promise.resolve([]);
    env.fetchHandler = (url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      return u.pathname === "/v2/surveys" ? fakeResponse({ body: { surveys: [DEF] } }) : fakeResponse({ body: { ok: true } });
    };
    const b = await ask(env, { type: "BB_SURVEY_BEGIN", entry: "invite", lang: "en" });
    assert.equal(b.ok, true);
    const s = await ask(env, { type: "BB_SURVEY_SUBMIT", surveyId: "sample-a", answers: { q_devices: ["pc"] }, final: false, entry: "invite", lang: "en" });
    assert.equal(s.ok, true);
    assert.equal((await ask(env, { type: "BB_SURVEY_PAGE", surveyId: "sample-a", page: 1, question: "q_devices", ms: 10, entry: "invite", lang: "en" })).ok, true);
    assert.equal((await ask(env, { type: "BB_SURVEY_CLOSED", surveyId: "sample-a", page: 1, entry: "invite", lang: "en" })).ok, true);
    await env.settle(20);
    assert.ok(calls.includes("/v2/surveys") && calls.includes("/v2/surveys/responses") && calls.includes("/v2/surveys/events/batch"));
    assert.ok(env.storage.surveyStates["sample-a"].closedAt > 0);
    env.close();
  });
  test("BB_SURVEY_FLUSH：佇列裡的事件用 keepalive 立刻送出", async () => {
    const env = bootBackground();
    const calls = [];
    env.chrome.runtime.getContexts = () => Promise.resolve([]);
    env.fetchHandler = (url, init = {}) => {
      const u = new URL(url);
      calls.push({ path: u.pathname, keepalive: !!init.keepalive, body: init.body ? JSON.parse(init.body) : null });
      return u.pathname === "/v2/surveys" ? fakeResponse({ body: { surveys: [DEF] } }) : fakeResponse({ status: 204 });
    };
    assert.equal((await ask(env, { type: "BB_SURVEY_BEGIN", entry: "invite", lang: "en" })).ok, true);
    await env.settle(20);
    assert.equal(calls.filter((c) => c.path === "/v2/surveys/events/batch").length, 0);
    assert.deepEqual(plain(await ask(env, { type: "BB_SURVEY_FLUSH" })), { ok: true });
    const b = calls.filter((c) => c.path === "/v2/surveys/events/batch");
    assert.equal(b.length, 1);
    assert.equal(b[0].keepalive, true);
    assert.deepEqual(plain(b[0].body.events), [{ kind: "shown" }]);
    env.close();
  });
  test("BB_TELEMETRY_BLOCKED／HEARTBEAT 都回 ok（失敗也靜默）", async () => {
    const env = bootBackground({ storage: { telemetrySample: true } });
    const paths = [];
    env.fetchHandler = (url) => { paths.push(new URL(url).pathname); throw new TypeError("Failed to fetch"); };
    assert.deepEqual(plain(await ask(env, { type: "BB_TELEMETRY_BLOCKED" })), { ok: true });
    assert.deepEqual(plain(await ask(env, { type: "BB_TELEMETRY_HEARTBEAT" })), { ok: true });
    assert.deepEqual(paths, ["/v1/telemetry/blocked", "/v1/telemetry/heartbeat"]);
    env.close();
  });
  test("公告連結：目前分頁是 B 站 → 請它打開；不是 → 開新分頁到首頁帶 #bb-survey", async () => {
    const env = bootBackground({ tabs: [{ id: 7, url: "https://www.bilibili.com/video/BV1xx" }], tabResponder: () => ({ ok: true }) });
    env.chrome.windows = { getLastFocused: (o, cb) => cb({ id: 1 }), update: (id, o, cb) => cb && cb() };
    env.chrome.tabs.update = (id, o, cb) => cb && cb();
    await ask(env, { type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT", surveyId: "sample-a" });
    await env.settle();
    assert.deepEqual(plain(env.tabMessages), [{ tabId: 7, msg: { type: "BB_SURVEY_SHOW", surveyId: "sample-a", entry: "announcement" } }]);
    assert.equal(env.createdTabs.length, 0);
    env.close();
    const other = bootBackground({ tabs: [{ id: 8, url: "https://example.com/" }] });
    other.chrome.windows = { getLastFocused: (o, cb) => cb({ id: 1 }) };
    await ask(other, { type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT", surveyId: "sample-a" });
    await ask(other, { type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT" });
    await other.settle();
    assert.deepEqual(plain(other.createdTabs), [{ url: "https://www.bilibili.com/#bb-survey=sample-a" }, { url: "https://www.bilibili.com/#bb-survey" }]);
    other.close();
  });
  test("console 指令 bbSurvey()：用 console 入口打開（可指定問卷）；清單快取一律丟掉；reset 先清掉本機的問卷紀錄", async () => {
    const env = bootBackground({ tabs: [{ id: 7, url: "https://www.bilibili.com/" }], tabResponder: () => ({ ok: true }), storage: { surveyStates: { "sample-a": { doneAt: 1, responseId: "a".repeat(32) } }, surveyList: { at: 1 }, installedAt: 5 } });
    env.chrome.windows = { getLastFocused: (o, cb) => cb({ id: 1 }), update: (id, o, cb) => cb && cb() };
    env.chrome.tabs.update = (id, o, cb) => cb && cb();
    assert.equal(typeof env.window.bbSurvey, "function", "Service Worker console 叫得到");
    await env.window.bbSurvey("sample-a");
    await env.settle();
    assert.equal(env.storage.surveyStates["sample-a"].doneAt, 1, "沒帶 reset 不動紀錄");
    assert.equal(env.storage.surveyList, undefined, "清單快取一律丟掉、重拿最新的");
    assert.deepEqual(plain(env.tabMessages), [{ tabId: 7, msg: { type: "BB_SURVEY_SHOW", surveyId: "sample-a", entry: "console" } }]);
    await env.window.bbSurvey({ reset: true });
    await env.settle();
    assert.equal(env.storage.surveyStates, undefined);
    assert.equal(env.storage.installedAt, 5, "其他設定不動");
    assert.deepEqual(plain(env.tabMessages[1].msg), { type: "BB_SURVEY_SHOW", surveyId: "", entry: "console" });
    env.close();
  });
  test("公告連結：B 站分頁沒回應（頁面還沒載入新程式）→ 退回開新分頁", async () => {
    const env = bootBackground({ tabs: [{ id: 7, url: "https://www.bilibili.com/" }], tabResponder: () => undefined });
    env.chrome.windows = { getLastFocused: (o, cb) => cb({ id: 1 }) };
    await ask(env, { type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT" });
    await env.settle();
    assert.equal(env.createdTabs.length, 1);
    env.close();
  });
});

describe("announcement.js：公告裡的問卷連結", () => {
  function bootAnn() {
    const env = createEnv({ url: "chrome-extension://bcs-test/announcement.html?id=1", htmlFile: "announcement.html" });
    env.load("i18n.js").load("common.js").load("lottery-text.js").load("html-sanitize.js").load("announcement.js");
    return env;
  }
  test("https://www.bilibili.com/#bb-survey(=<問卷 id>) 不另開網頁，改請背景處理；其他連結照舊開新分頁", async () => {
    const env = bootAnn();
    await env.settle(30);
    const { openLink } = env.internals("announcement");
    openLink("https://www.bilibili.com/#bb-survey");
    openLink("https://www.bilibili.com/#bb-survey=sample-a");
    openLink("https://www.bilibili.com/?x=1#bb-survey");
    assert.deepEqual(plain(env.runtimeMessages.filter((m) => m.type === "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT")), [{ type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT", surveyId: "" }, { type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT", surveyId: "sample-a" }]);
    assert.deepEqual(plain(env.createdTabs), [{ url: "https://www.bilibili.com/?x=1#bb-survey" }], "帶 query 的不算問卷連結");
    openLink("https://lazy-cv.com/docs");
    assert.equal(env.createdTabs.length, 2);
    env.close();
  });
});
