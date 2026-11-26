// 問卷視窗（survey-window.html／survey-window.js）：popup 點到「問卷公告」時開的單獨視窗。
// 畫面同 B 站頁面上的問卷（survey-ui.js，inWindow），流程同公告入口；問卷收掉時視窗跟著關。背景用假回應。
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, closeAll } from "./helpers/load.mjs";

after(closeAll);

const L = (s) => ({ zh_TW: s, zh_CN: s, zh_HK: s, en: s, ja: s, ko: s });
const DEF = {
  id: "sample-survey", title: L("TITLE"), prompt: { invite: L("INVITE"), announcement: L("FROM ANNOUNCEMENT") },
  questions: [{ id: "q1", type: "single", required: true, text: L("pick?"), options: [{ id: "a", text: L("A") }, { id: "b", text: L("B") }] }]
};

function boot({ id = "sample-survey", begin, submit, uiLanguage } = {}) {
  const env = createEnv({ htmlFile: "survey-window.html", url: "chrome-extension://bcs-test/survey-window.html" + (id != null ? "?id=" + id : ""), uiLanguage });
  const timers = new Map();
  let n = 0, closed = 0;
  env.window.setTimeout = (fn, ms) => { timers.set(++n, { fn, ms }); return n; };
  env.window.clearTimeout = (x) => { timers.delete(x); };
  env.window.close = () => { closed++; };
  env.chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "BB_SURVEY_BEGIN") { respond(begin ? begin(msg) : { ok: true, def: DEF, answers: {}, order: {}, responseId: "r".repeat(32), entry: "announcement", needTelemetryConsent: false }); return true; }
    if (msg.type === "BB_SURVEY_SUBMIT") { respond(submit ? submit(msg) : { ok: true }); return true; }
    if (msg.type === "BB_SURVEY_PAGE" || msg.type === "BB_SURVEY_CLOSED") { respond({ ok: true }); return true; }
  });
  ["i18n.js", "common.js", "survey-core.js", "survey-ui.js", "survey-window.js"].forEach((f) => env.load(f));
  const root = () => { const h = env.document.querySelector("[data-bb-survey]"); return h && h.shadowRoot; };
  const fire = (ms) => { const hit = Array.from(timers.entries()).filter(([, x]) => x.ms === ms); hit.forEach(([k, x]) => { timers.delete(k); x.fn(); }); return hit.length; };
  const sent = (type) => env.runtimeMessages.filter((m) => m.type === type);
  const btn = (text) => Array.from(root().querySelectorAll("button")).find((b) => b.textContent === text);
  return { env, root, fire, sent, btn, closed: () => closed };
}

describe("問卷視窗", () => {
  test("用公告入口開問卷；畫面同 B 站頁面上的那份，只是不畫遮罩、填滿視窗", async () => {
    const t = boot();
    await t.env.settle();
    assert.deepEqual(t.sent("BB_SURVEY_BEGIN").map((m) => [m.entry, m.surveyId, m.lang]), [["announcement", "sample-survey", "en"]]);
    assert.ok(t.root().querySelector(".ov.win"), "視窗版（inWindow）");
    assert.match(t.root().querySelector(".card").textContent, /TITLE/);
    assert.match(t.root().querySelector(".card").textContent, /FROM ANNOUNCEMENT/, "公告入口的說明文字");
    assert.equal(t.env.document.title, "TITLE");
    t.env.close();
  });
  test("送出成功：動畫播完畫面收掉，視窗跟著關", async () => {
    const t = boot();
    await t.env.settle();
    t.btn("A").click();
    await t.env.settle();
    const fin = t.sent("BB_SURVEY_SUBMIT").filter((m) => m.final);
    assert.equal(fin.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify([fin[0].surveyId, fin[0].entry, fin[0].answers])), ["sample-survey", "announcement", { q1: "a" }]);
    assert.equal(t.closed(), 0, "動畫還沒播完");
    const SUCCESS_MS = t.env.window.BBSurveyUI.SUCCESS_MS;
    t.fire(SUCCESS_MS - 250);
    t.fire(SUCCESS_MS);
    assert.equal(t.closed(), 1);
    t.env.close();
  });
  test("按 ×：立刻記關掉（BB_SURVEY_CLOSED），顯示提示；提示結束（或再按 ×）視窗才關", async () => {
    const t = boot();
    await t.env.settle();
    t.root().querySelector(".x").click();
    await t.env.settle();
    assert.equal(t.sent("BB_SURVEY_CLOSED").length, 1);
    assert.equal(t.closed(), 0, "提示還在");
    t.fire(t.env.window.BBSurveyUI.CLOSED_NOTICE_MS);
    assert.equal(t.closed(), 1);
    t.env.close();
  });
  test("視窗關掉（pagehide）或縮到背景（visibilitychange → hidden）：請背景立刻送出問卷事件", async () => {
    const t = boot();
    await t.env.settle();
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 0);
    t.env.window.dispatchEvent(new t.env.window.Event("pagehide"));
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 1);
    Object.defineProperty(t.env.document, "visibilityState", { value: "hidden", configurable: true });
    t.env.document.dispatchEvent(new t.env.window.Event("visibilitychange"));
    assert.equal(t.sent("BB_SURVEY_FLUSH").length, 2);
    t.env.close();
  });
  test("Esc 一樣；提示上再按 Esc 直接關視窗", async () => {
    const t = boot();
    await t.env.settle();
    const esc = () => t.env.window.dispatchEvent(new t.env.window.KeyboardEvent("keydown", { key: "Escape" }));
    esc();
    assert.equal(t.sent("BB_SURVEY_CLOSED").length, 1);
    assert.equal(t.closed(), 0);
    esc();
    assert.equal(t.closed(), 1);
    assert.equal(t.sent("BB_SURVEY_CLOSED").length, 1, "提示上關不再記一次");
    t.env.close();
  });
  test("問卷已經結束：顯示「已經結束」，按關閉視窗跟著關", async () => {
    const t = boot({ begin: () => ({ ok: false, reason: "ended" }) });
    await t.env.settle();
    const msg = t.env.chrome.i18n.getMessage("surveyEnded");
    assert.match(t.root().querySelector(".card").textContent, new RegExp(msg));
    t.btn(t.env.chrome.i18n.getMessage("surveyClose")).click();
    assert.equal(t.closed(), 1);
    t.env.close();
  });
  test("背景沒回應或其他原因：說失敗，不留空白視窗；網址的 id 不對就直接說已經結束、不問背景", async () => {
    const t = boot({ begin: () => ({ ok: false, reason: "unavailable" }) });
    await t.env.settle();
    assert.match(t.root().querySelector(".card").textContent, new RegExp(t.env.chrome.i18n.getMessage("surveyFail")));
    t.env.close();
    const t2 = boot({ id: "Bad%20Id" });
    await t2.env.settle();
    assert.equal(t2.sent("BB_SURVEY_BEGIN").length, 0);
    assert.match(t2.root().querySelector(".card").textContent, new RegExp(t2.env.chrome.i18n.getMessage("surveyEnded")));
    t2.env.close();
  });
  test("語言：跟著瀏覽器（中文 → zh_TW、簡體 → zh_CN、日文 → ja）", async () => {
    for (const [ui, want] of [["zh-TW", "zh_TW"], ["zh-CN", "zh_CN"], ["ja", "ja"], ["fr", "en"]]) {
      const t = boot({ uiLanguage: ui });
      await t.env.settle();
      assert.equal(t.sent("BB_SURVEY_BEGIN")[0].lang, want, ui);
      t.env.close();
    }
  });
});
