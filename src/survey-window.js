"use strict";
/*
 * 問卷視窗（survey-window.html?id=<問卷 id>）：popup 跑馬燈點到「問卷公告」時，由 background 開成獨立視窗（同公告視窗）。
 *  - 畫面用 survey-ui.js（跟 B 站頁面上的問卷一模一樣，只是不畫遮罩、卡片填滿視窗：inWindow）
 *  - 流程同 survey-page.js 的公告入口（entry "announcement"）：背景的 BB_SURVEY_BEGIN／SUBMIT／PAGE／CLOSED，規則在 survey.js
 *    （填過也能重填、送出後覆蓋同一筆；關掉記 closedAt，不影響公告；問卷已經結束就說「已經結束」）
 *  - 問卷畫面整個收掉（送出成功的動畫播完、按 × 或 Esc 後的提示結束、「已經結束」按關閉）時，視窗跟著關（onGone）
 * 語言：popup 進階設定選的語言優先（i18n.js 的 uiLangPref，跟 popup 同一個 localStorage），其次瀏覽器（同 survey-page.js 的判斷）。
 */
var SURVEY_WINDOW_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/; // 同 survey-core.js 的問卷 id
var SURVEY_UI_KEYS = {
  next: "surveyNext", prev: "surveyPrev", skipSubmit: "surveySkipSubmit", submit: "surveySubmit", thanks: "surveyThanks",
  ended: "surveyEnded", close: "surveyClose", consent: "surveyTelemetryConsent", fail: "surveyFail", badEmail: "surveyBadEmail",
  moveUp: "surveyMoveUp", moveDown: "surveyMoveDown", closedNotice: "surveyClosedNotice"
};

// 問卷的語言代碼（zh_TW、zh_HK、zh_CN、en、ja、ko）
function surveyLang() {
  var LANGS = BBSurveyCore.LANGS;
  if (LANGS.indexOf(window.uiLangPref) >= 0) return window.uiLangPref;
  if (LANGS.indexOf(window.uiAutoLang) >= 0) return window.uiAutoLang; // 跟隨瀏覽器、偵測到粵語區（i18n.js）
  var low = "";
  try { low = String(chrome.i18n.getUILanguage() || "").toLowerCase().replace("_", "-"); } catch (e) {}
  if (low.indexOf("ja") === 0) return "ja";
  if (low.indexOf("ko") === 0) return "ko";
  if (low.indexOf("zh") === 0) return /cn|hans|sg/.test(low) ? "zh_CN" : "zh_TW";
  return "en";
}
// 按鈕等介面文字（common.js 的 t() 已經處理 popup 選的語言）；頁首的品牌名用 brandName（中文是「嗶速 | BiBoost」）
function surveyUiStrings() {
  var out = {};
  Object.keys(SURVEY_UI_KEYS).forEach(function (k) { var v = t(SURVEY_UI_KEYS[k]); if (v && v !== SURVEY_UI_KEYS[k]) out[k] = v; });
  var brand = t("brandName");
  if (brand && brand !== "brandName") out.brand = brand;
  return out;
}

function sendBg(msg) {
  return new Promise(function (resolve) {
    try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; resolve(r || null); }); }
    catch (e) { resolve(null); }
  });
}
function closeWindow() { try { window.close(); } catch (e) {} }

function startSurveyWindow(surveyId) {
  var lang = surveyLang(), ui = surveyUiStrings();
  document.documentElement.lang = lang.replace("_", "-");
  document.title = ui.brand || "BiBoost";
  // 只顯示一句話＋「關閉」（問卷已經結束；或背景沒回應這類意外，改說「失敗，請稍後再試」）
  function notice(text) {
    return BBSurveyUI.open({ ended: true, def: { questions: [], title: null }, lang: lang, inWindow: true,
      ui: Object.assign({}, ui, { ended: text }), onClose: function () {}, onGone: closeWindow });
  }
  if (!SURVEY_WINDOW_ID_RE.test(surveyId || "")) return Promise.resolve(notice(ui.ended));
  return sendBg({ type: "BB_SURVEY_BEGIN", entry: "announcement", surveyId: surveyId, lang: lang }).then(function (r) {
    if (!r || !r.ok) return notice(r && r.reason === "ended" ? ui.ended : ui.fail);
    var def = r.def, chain = Promise.resolve();
    var base = { surveyId: def.id, entry: r.entry || "announcement", lang: lang };
    var prompt = def.prompt && (def.prompt.announcement || def.prompt.invite);
    var title = BBSurveyCore.pick(def.title, lang);
    if (title) document.title = title;
    return BBSurveyUI.open({
      def: def, answers: r.answers, order: r.order, lang: lang, ui: ui, inWindow: true,
      promptText: prompt ? BBSurveyCore.pick(prompt, lang) : "", showConsent: !!r.needTelemetryConsent,
      // 每答一題送一次（依序，免得後送的被先到的蓋掉）
      onAnswer: function (answers) {
        chain = chain.then(function () { return sendBg(Object.assign({ type: "BB_SURVEY_SUBMIT", answers: answers, final: false }, base)); });
        return chain;
      },
      onSubmit: function (answers, extra) {
        chain = chain.then(function () { return sendBg(Object.assign({ type: "BB_SURVEY_SUBMIT", answers: answers, final: true, telemetryConsent: !!(extra && extra.telemetryConsent) }, base)); });
        return chain;
      },
      onPage: function (info) { sendBg(Object.assign({ type: "BB_SURVEY_PAGE", page: info.page, question: info.question, ms: info.ms }, base)); },
      onClose: function (info) { if (info && info.byUser) sendBg(Object.assign({ type: "BB_SURVEY_CLOSED", page: info.page }, base)); },
      // 畫面收掉（成功動畫、關掉後的提示都結束）才關視窗；送出中的請求由背景處理，不受視窗關閉影響
      onGone: closeWindow
    });
  });
}

var SURVEY_WINDOW_PARAM = new URLSearchParams(location.search).get("id") || "";
startSurveyWindow(SURVEY_WINDOW_PARAM);

// Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") {
  globalThis.__BCS_TEST__.register("survey-window", { surveyLang: surveyLang, surveyUiStrings: surveyUiStrings, startSurveyWindow: startSurveyWindow });
}
