/*
 * 問卷與匿名統計的頁面端（B 站頁面，ISOLATED world 的 content script，只在最上層 frame 跑；畫面在 survey-ui.js，背景端在 survey.js）。
 *  1) 抽樣播放心跳：每個整 5 分鐘的牆鐘時刻（:00、:05…），這個分頁的主影片正在播放就請背景送一次（背景決定這個安裝有沒有被抽中）。
 *     所有人在同一個時刻取樣，伺服器端的桶數量×10 就是那一刻的同時播放人數；每個分頁各自計算、不去重
 *  2) 遇到地區限定：main-hook.js 偵測到番劇因所在地區不能看（playurl 回 -10403，或 playview／頁面寫入的 __PLAYURL_HYDRATE_DATA__ 帶 AreaLimitPanel）
 *     → 請背景計一次，並觸發事件 region_blocked（有接這個事件的問卷才出現；要不要出現由背景決定）
 *  3) 頁面邀請（invite）：只在沒在看影片的時候——剛進首頁、這個分頁還沒播過影片，停留約 5 秒後；或影片播完（ended）後 10 秒內沒有開始下一部。
 *     播放中、暫停中、全螢幕、分頁在背景都不出現。挑哪一份、冷卻、今天出現過沒，由背景決定（見 survey.js）
 *  4) 公告裡的連結 https://www.bilibili.com/#bb-survey=<問卷 id>（沒有 id＝任一份還沒填完的；結尾 &console 是 bbSurvey() 開的）。
 *     目前分頁是 B 站就由背景傳訊息過來，不是就開新分頁帶這個 hash
 * main-hook.js（MAIN world）用 window.postMessage 送來 video-state（none／playing／paused／ended）與 region-blocked。
 */
(function () {
  "use strict";
  if (window.top !== window) return;

  var SLOT_MS = 5 * 60 * 1000, SLOT_TOLERANCE_MS = 60 * 1000;
  var HOME_DELAY_MS = 5000, ENDED_DELAY_MS = 10000;
  var HASH_RE = /^#bb-survey(?:=([a-z0-9][a-z0-9-]{1,47}))?(&console)?$/;
  var LANGS = BBSurveyCore.LANGS;
  var UI_KEYS = {
    next: "surveyNext", prev: "surveyPrev", skipSubmit: "surveySkipSubmit", submit: "surveySubmit", thanks: "surveyThanks",
    ended: "surveyEnded", close: "surveyClose", consent: "surveyTelemetryConsent", fail: "surveyFail", badEmail: "surveyBadEmail",
    moveUp: "surveyMoveUp", moveDown: "surveyMoveDown", closedNotice: "surveyClosedNotice"
  };

  var videoState = "none", everPlayed = false, open = null, starting = false;
  var endedTimer = null, homeTimer = null;

  function send(msg) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; resolve(r || null); }); }
      catch (e) { resolve(null); }
    });
  }
  function storageGet(defaults) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(defaults, function (s) { resolve(s || defaults); }); } catch (e) { resolve(defaults); }
    });
  }

  // ---- 語言：popup 進階設定選的語言優先，其次瀏覽器；瀏覽器是粵語區（香港／澳門）時用 zh_HK（同 i18n.js 的判斷）----
  function detectLang(pref) {
    if (LANGS.indexOf(pref) >= 0) return pref;
    var ui = "", first = "";
    try { ui = String(chrome.i18n.getUILanguage() || ""); } catch (e) {}
    try { first = String((navigator.languages && navigator.languages[0]) || navigator.language || ""); } catch (e) {}
    var low = ui.toLowerCase().replace("_", "-"), f = first.toLowerCase().replace("_", "-");
    var isHk = function (l) { return /^(yue|zh-(hk|mo)|zh-hant-(hk|mo))/.test(l); };
    if (low.indexOf("ja") === 0) return "ja";
    if (low.indexOf("ko") === 0) return "ko";
    if (low.indexOf("zh") === 0) {
      if (isHk(low) || isHk(f)) return "zh_HK";
      return /cn|hans|sg/.test(low) ? "zh_CN" : "zh_TW";
    }
    return "en";
  }
  function uiStrings(uiMsgs) {
    var out = {};
    Object.keys(UI_KEYS).forEach(function (k) {
      var v = uiMsgs && uiMsgs[UI_KEYS[k]];
      if (!v) { try { v = chrome.i18n.getMessage(UI_KEYS[k]); } catch (e) {} }
      if (v) out[k] = v;
    });
    // 頁首的品牌名用 brandName（中文是「嗶速 | BiBoost」）。uiMsgs 是使用者在 popup 選語言時存的整份文案，
    // 更新前存的那份沒有 brandName，就用瀏覽器語系的
    var brand = uiMsgs && uiMsgs.brandName;
    if (!brand) { try { brand = chrome.i18n.getMessage("brandName"); } catch (e) {} }
    if (brand) out.brand = brand;
    return out;
  }

  // ---- 問卷 ----
  function whenBodyReady(fn) {
    if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }
  // entry："invite"（頁面邀請）｜事件名稱（例如 "region_blocked"）｜"announcement"（公告連結）｜"console"（bbSurvey()）
  function startSurvey(entry, surveyId) {
    if (open || starting) return;
    starting = true;
    storageGet({ uiLang: "auto", uiMsgs: null }).then(function (s) {
      var lang = detectLang(s.uiLang), ui = uiStrings(s.uiMsgs);
      return send({ type: "BB_SURVEY_BEGIN", entry: entry, surveyId: surveyId || "", lang: lang }).then(function (r) {
        starting = false;
        if (!r) return;
        if (!r.ok) {
          // 只有使用者自己打開的（公告、console）才說明為什麼沒有問卷（問卷已經結束）；自動觸發的不出聲。填過的從公告打開是重填，不會走到這裡
          var manual = entry === "announcement" || entry === "console";
          if (manual && r.reason === "ended") {
            whenBodyReady(function () { open = BBSurveyUI.open({ ended: true, def: { questions: [], title: r.title || null }, lang: lang, ui: ui, onClose: function () { open = null; } }); });
          }
          return;
        }
        var def = r.def, chain = Promise.resolve();
        var prompt = def.prompt && (def.prompt[entry] || def.prompt.invite);
        var base = { surveyId: def.id, entry: r.entry || entry, lang: lang };
        whenBodyReady(function () {
          open = BBSurveyUI.open({
            def: def, answers: r.answers, order: r.order, lang: lang, ui: ui, promptText: prompt ? BBSurveyCore.pick(prompt, lang) : "", showConsent: !!r.needTelemetryConsent,
            // 每答一題送一次（依序，免得後送的被先到的蓋掉）
            onAnswer: function (answers) {
              chain = chain.then(function () { return send(Object.assign({ type: "BB_SURVEY_SUBMIT", answers: answers, final: false }, base)); });
              return chain;
            },
            onSubmit: function (answers, extra) {
              chain = chain.then(function () { return send(Object.assign({ type: "BB_SURVEY_SUBMIT", answers: answers, final: true, telemetryConsent: !!(extra && extra.telemetryConsent) }, base)); });
              return chain;
            },
            // 離開一頁（下一題、上一題、關掉）：第幾頁、哪一題、停留多久
            onPage: function (info) { send(Object.assign({ type: "BB_SURVEY_PAGE", page: info.page, question: info.question, ms: info.ms }, base)); },
            onClose: function (info) {
              open = null;
              if (info && info.byUser) send(Object.assign({ type: "BB_SURVEY_CLOSED", page: info.page }, base));
            }
          });
        });
      });
    }).catch(function () { starting = false; });
  }

  // ---- 頁面邀請：沒在看影片的時候 ----
  function canInvite() {
    return !open && !starting && document.visibilityState === "visible" && !document.fullscreenElement && (videoState === "none" || videoState === "ended");
  }
  // 首頁：海外的人會被導到 /zh-Hant 這類語言路徑（真瀏覽器實測），所以 /、/index.html 和單一個語言段（/zh-Hant、/en、/ja…）都算
  var HOME_PATH_RE = /^\/(index\.html|[a-z]{2}(-[a-z]+)?)?\/?$/i;
  function isHome() { return location.hostname === "www.bilibili.com" && HOME_PATH_RE.test(location.pathname); }
  function armHome() {
    if (homeTimer || everPlayed || !isHome()) return;
    homeTimer = setTimeout(function () {
      homeTimer = null;
      if (everPlayed || videoState !== "none") return;
      if (document.visibilityState !== "visible") { document.addEventListener("visibilitychange", function () { armHome(); }, { once: true }); return; }
      if (canInvite()) startSurvey("invite");
    }, HOME_DELAY_MS);
  }
  function onVideoState(st) {
    if (st === videoState) return;
    videoState = st;
    if (st === "playing") {
      everPlayed = true;
      if (homeTimer) { clearTimeout(homeTimer); homeTimer = null; }
    }
    if (endedTimer) { clearTimeout(endedTimer); endedTimer = null; }
    if (st === "ended") {
      endedTimer = setTimeout(function () {
        endedTimer = null;
        if (videoState === "ended" && canInvite()) startSurvey("invite");
      }, ENDED_DELAY_MS);
    }
  }

  // ---- 抽樣播放心跳：每個整 5 分鐘 ----
  function scheduleSlot() {
    var now = Date.now(), slot = Math.ceil((now + 1000) / SLOT_MS) * SLOT_MS;
    setTimeout(function () {
      // 計時器被瀏覽器延遲太久（背景分頁、睡眠）就跳過這一次：取樣時刻要對得上
      if (videoState === "playing" && Math.abs(Date.now() - slot) < SLOT_TOLERANCE_MS) {
        storageGet({ telemetrySample: null }).then(function (s) {
          if (s.telemetrySample === false) return; // 沒被抽中：不用叫醒背景
          send({ type: "BB_TELEMETRY_HEARTBEAT" });
        });
      }
      scheduleSlot();
    }, slot - now);
  }

  // ---- 來自 main-hook.js 的訊息 ----
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__cdnSwitcher !== 1) return;
    if (d.dir === "video-state" && d.payload && typeof d.payload.state === "string") { onVideoState(d.payload.state); return; }
    if (d.dir === "region-blocked") {
      send({ type: "BB_TELEMETRY_BLOCKED" });
      startSurvey("region_blocked");
    }
  });

  // ---- 公告連結 ----
  function fromHash() {
    var m = HASH_RE.exec(location.hash || "");
    if (!m) return;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    startSurvey(m[2] ? "console" : "announcement", m[1] || "");
  }
  fromHash();
  window.addEventListener("hashchange", fromHash);
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === "BB_SURVEY_SHOW") {
        startSurvey(msg.entry === "console" ? "console" : "announcement", msg.surveyId || "");
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (e) {}

  // 問卷開著時頁面要關掉或切到背景：請背景把還沒送的事件立刻送出（背景合併事件，見 survey.js 的 trackEvent）
  function flushIfOpen() { if (open) send({ type: "BB_SURVEY_FLUSH" }); }
  window.addEventListener("pagehide", flushIfOpen);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushIfOpen(); });

  armHome();
  scheduleSlot();

  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") {
    globalThis.__BCS_TEST__.register("survey-page", {
      detectLang: detectLang, uiStrings: uiStrings, isHome: isHome, startSurvey: startSurvey, onVideoState: onVideoState, canInvite: canInvite, armHome: armHome,
      isOpen: function () { return !!open; }, state: function () { return { videoState: videoState, everPlayed: everPlayed }; },
      HOME_DELAY_MS: HOME_DELAY_MS, ENDED_DELAY_MS: ENDED_DELAY_MS, SLOT_MS: SLOT_MS
    });
  }
})();
