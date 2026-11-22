// 問卷與匿名統計（背景端）。頁面端見 survey-page.js（觸發時機、心跳計時），畫面在 survey-ui.js，規則（分頁、跳題）在 survey-core.js。
//
// 匿名統計（長期收集）
//   · 抽樣播放心跳 POST <API>/v1/telemetry/heartbeat：10% 的安裝才會送（第一次要送時抽籤、存在 telemetrySample），不帶內容，伺服器依 IP 只記國家
//   · 遇到地區限定 POST <API>/v1/telemetry/blocked：每個安裝都送，同樣不帶內容
//   · 失敗一律靜默、不重試。Firefox 要使用者同意 data_collection 的 technicalAndInteraction 才送（問卷事件、觸發機會也是）
// 問卷（admin 管理的多份問卷，伺服器下發；沒有功能開關）
//   · GET <API>/v2/surveys?lang=&v=：進行中、給這個國家與語言、這個版本畫得出來的問卷，快取 LIST_TTL（6 小時）
//   · 觸發：invite（頁面邀請，survey-page.js 判斷時機）、事件（EVENTS，例如 region_blocked）、announcement（公告連結）、console（bbSurvey()）
//   · 每份問卷在這台記 shownAt／closedAt（按 × 或 Esc）／doneAt（送出完成）；關掉或填完就不再自動出現。
//     填過的紀錄另外同步到 chrome.storage.sync（同一個瀏覽器帳號的各台電腦、重裝後都算填過，重填沿用同一個 responseId）
//   · 公告與 console 填過、關掉過都照樣能開：填過的是重填，從空白開始，送出後覆蓋伺服器上同一筆
//   · 門檻（公告與 console 不看）：歡迎視窗開著不出現；今天出現過問卷但沒關掉也沒填完 → 今天不再出現任何問卷；
//     invite 另外要：安裝滿 3 天、距離上次「關掉或填完」任何問卷滿 3 天。事件不看這兩個 3 天
//   · 有好幾份候選時依 weight 隨機挑一份；觸發機會的結果（出現了／冷卻中…）每次都計數
//   · 每答一題送一次 POST <API>/v2/surveys/responses（response_id 每份問卷每台安裝一個亂數，中途離開再開接著填）；
//     出現、換頁、關掉、完成送 POST <API>/v2/surveys/events
// storage.local：surveyList = { api, lang, v, at, surveys }、surveyStates = { <id>: { shownAt, closedAt, doneAt, responseId, answers, order } }、
//   surveyLastEndedAt（上次關掉或填完的時間）、surveyLastShown = { day, id }（本機日期）
// storage.sync：surveyDone = { <id>: { d: doneAt, r: responseId } }（最近 SYNC_MAX 份）
var BBSurvey = (function () {
  "use strict";
  var LIST_KEY = "surveyList", STATES_KEY = "surveyStates", ENDED_KEY = "surveyLastEndedAt", SHOWN_KEY = "surveyLastShown", SAMPLE_KEY = "telemetrySample";
  var LIST_TTL = 6 * 3600 * 1000, SAMPLE_RATE = 0.1, COOLDOWN_MS = 3 * 86400000, NEW_INSTALL_MS = 3 * 86400000;
  var AUTO = ["invite"].concat(BBSurveyCore.EVENTS);
  var SYNC_KEY = "surveyDone", SYNC_MAX = 40, SYNC_TIMEOUT_MS = 3000;

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, function (s) { r(s || {}); }); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; r(); }); }); }
  function isFirefox() { return typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent || ""); }
  function browserName() {
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (ua.indexOf("Firefox/") !== -1) return "firefox";
    if (ua.indexOf("Edg/") !== -1) return "edge";
    if (ua.indexOf("Chrome/") !== -1) return "chrome";
    return "safari";
  }
  function extVersion() { try { return String(chrome.runtime.getManifest().version || "0").slice(0, 16); } catch (e) { return "0"; } }
  function randomHex(bytes) {
    var a = crypto.getRandomValues(new Uint8Array(bytes)), out = "";
    for (var i = 0; i < a.length; i++) out += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return out;
  }
  // 本機時區的日期（「今天」用）
  function localDay(t) { var d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  // ---- Firefox 的 data_collection 權限（其他瀏覽器沒有這個概念，一律視為已同意）----
  function fxHas(perms) {
    if (!isFirefox()) return Promise.resolve(true);
    if (!perms.length) return Promise.resolve(true);
    try { return Promise.resolve(browser.permissions.contains({ data_collection: perms })).then(function (ok) { return !!ok; }, function () { return false; }); }
    catch (e) { return Promise.resolve(false); }
  }
  // 要求權限：只能在使用者動作（點「送出」）觸發的訊息處理裡呼叫；不行（或被拒）就回 false
  function fxRequest(perms) {
    if (!isFirefox() || !perms.length) return Promise.resolve(true);
    return fxHas(perms).then(function (has) {
      if (has) return true;
      try { return Promise.resolve(browser.permissions.request({ data_collection: perms })).then(function (ok) { return !!ok; }, function () { return false; }); }
      catch (e) { return false; }
    });
  }

  function api() { return BBFeatures.apiBase(); }
  // 失敗（網路等例外）不丟例外：回 null。回傳 fetch 的 Response
  function request(path, init) {
    return api().then(function (base) {
      return fetch(base + path, Object.assign({ credentials: "omit", cache: "no-store" }, init || {}));
    }).catch(function () { return null; });
  }
  function postJson(path, body) {
    return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  // 使用情形（事件、觸發機會）：Firefox 要同意匿名統計才送；失敗靜默
  function track(path, body) {
    return fxHas(["technicalAndInteraction"]).then(function (ok) { return ok ? postJson(path, body) : null; }).then(function () {}, function () {});
  }

  // ---- 匿名統計 ----
  function sampled() {
    return get(SAMPLE_KEY).then(function (s) {
      if (typeof s[SAMPLE_KEY] === "boolean") return s[SAMPLE_KEY];
      var pick = Math.random() < SAMPLE_RATE, o = {};
      o[SAMPLE_KEY] = pick;
      return set(o).then(function () { return pick; });
    });
  }
  function ping(path) {
    return fxHas(["technicalAndInteraction"]).then(function (ok) {
      return ok ? request(path, { method: "POST" }) : null;
    }).then(function () { return true; }, function () { return false; });
  }
  function heartbeat() {
    return sampled().then(function (yes) { return yes ? ping("/v1/telemetry/heartbeat") : false; });
  }
  function blocked() { return ping("/v1/telemetry/blocked"); }

  // ---- 問卷清單 ----
  function validDef(d) {
    return !!d && typeof d.id === "string" && Array.isArray(d.questions) && d.questions.length > 0 &&
      d.questions.every(function (q) { return q && typeof q.id === "string" && typeof q.type === "string" && q.text && typeof q.text === "object"; });
  }
  // 進行中的問卷（給這個語言）。force：不看快取（公告、console）。拿不到就用舊的快取，再沒有就是空清單
  function getList(lang, force) {
    return Promise.all([get(LIST_KEY), api()]).then(function (arr) {
      var c = arr[0][LIST_KEY], base = arr[1], v = extVersion();
      var fresh = c && c.api === base && c.lang === lang && c.v === v && Date.now() - c.at < LIST_TTL;
      if (fresh && !force) return c.surveys;
      return request("/v2/surveys?lang=" + encodeURIComponent(lang) + "&v=" + encodeURIComponent(v), { method: "GET" }).then(function (r) {
        if (!r || !r.ok) return null;
        return r.json().then(function (j) {
          var list = (j && Array.isArray(j.surveys) ? j.surveys : []).filter(validDef);
          var o = {}; o[LIST_KEY] = { api: base, lang: lang, v: v, at: Date.now(), surveys: list };
          return set(o).then(function () { return list; });
        });
      }).catch(function () { return null; }).then(function (list) {
        return list || (c && c.api === base ? c.surveys : []);
      });
    });
  }

  function getStates() {
    return Promise.all([get([STATES_KEY, ENDED_KEY, SHOWN_KEY, "installedAt"]), syncDone()]).then(function (arr) {
      var s = arr[0];
      return {
        states: mergeSync(s[STATES_KEY] && typeof s[STATES_KEY] === "object" ? s[STATES_KEY] : {}, arr[1]),
        lastEndedAt: typeof s[ENDED_KEY] === "number" ? s[ENDED_KEY] : 0,
        lastShown: s[SHOWN_KEY] && typeof s[SHOWN_KEY] === "object" ? s[SHOWN_KEY] : null,
        installedAt: s.installedAt
      };
    });
  }
  function putStates(states, extra) { var o = Object.assign({}, extra || {}); o[STATES_KEY] = states; return set(o); }

  // ---- 填過的紀錄同步到 chrome.storage.sync（同一個瀏覽器帳號的各台電腦、重裝後都認得）----
  // sync 的 surveyDone = { <問卷 id>: { d: doneAt, r: responseId } }，不存答案。配額（單一項目 8KB、總共 100KB）：一筆約 100 位元組，
  // 只留 doneAt 最新的 SYNC_MAX 份（約 4KB）；被擠掉的是很久以前填的，那些問卷多半早就結束、不會再下發。
  // 不支援 sync（或出錯、逾時）時安靜退回只用本機
  function syncArea() { try { return (chrome.storage && chrome.storage.sync) || null; } catch (e) { return null; } }
  function syncCall(fn) {
    var area = syncArea();
    if (!area) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false, timer = setTimeout(function () { finish(null); }, SYNC_TIMEOUT_MS);
      function finish(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }
      try {
        var p = fn(area, function (v) { var err = chrome.runtime && chrome.runtime.lastError; finish(err ? null : v === undefined ? true : v); });
        if (p && typeof p.then === "function") p.then(null, function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }
  function syncDone() {
    return syncCall(function (a, cb) { return a.get(SYNC_KEY, cb); }).then(function (s) {
      var m = s && s[SYNC_KEY];
      return m && typeof m === "object" && !Array.isArray(m) ? m : {};
    });
  }
  function syncMarkDone(id, doneAt, responseId) {
    return syncDone().then(function (m) {
      m[id] = { d: doneAt, r: responseId };
      var keep = Object.keys(m).filter(function (k) { return m[k] && typeof m[k].d === "number"; })
        .sort(function (x, y) { return m[y].d - m[x].d; }).slice(0, SYNC_MAX);
      var o = {}, out = {};
      keep.forEach(function (k) { out[k] = { d: m[k].d, r: m[k].r }; });
      o[SYNC_KEY] = out;
      return syncCall(function (a, cb) { return a.set(o, cb); });
    });
  }
  // 本機紀錄與 sync 合併：任一邊有 doneAt 就算填過；responseId 以 sync 為準（同一個帳號在別台電腦、重裝後重填，覆蓋伺服器上同一筆）
  function mergeSync(states, m) {
    Object.keys(m).forEach(function (id) {
      var x = m[id];
      if (!x || typeof x.d !== "number") return;
      var st = Object.assign({}, states[id] || {});
      if (!st.doneAt) st.doneAt = x.d;
      if (typeof x.r === "string" && /^[0-9a-f]{32}$/.test(x.r)) st.responseId = x.r;
      states[id] = st;
    });
    return states;
  }
  function handled(st) { return !!(st && (st.closedAt || st.doneAt)); }

  // 歡迎視窗（welcome.html，全新安裝時開的小視窗）還開著：用 runtime.getContexts 查（Chrome 116+、Firefox 128+）；沒有這個 API 就當沒開
  function welcomeOpen() {
    try {
      if (!chrome.runtime || typeof chrome.runtime.getContexts !== "function") return Promise.resolve(false);
      var url = chrome.runtime.getURL("welcome.html"); // 網址可能帶 query／hash，自己比對開頭
      return Promise.resolve(chrome.runtime.getContexts({ contextTypes: ["TAB"] }))
        .then(function (c) { return (c || []).some(function (x) { return String(x && x.documentUrl || "").indexOf(url) === 0; }); }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // 自動出現（invite／事件）能不能出現 → null（可以）或觸發機會的結果代碼
  function gate(entry, g, now) {
    var ls = g.lastShown;
    if (ls && ls.day === localDay(now) && !handled(g.states[ls.id])) return "today";
    if (entry === "invite") {
      if (typeof g.installedAt === "number" && now - g.installedAt < NEW_INSTALL_MS) return "new_install";
      if (g.lastEndedAt && now - g.lastEndedAt < COOLDOWN_MS) return "cooldown";
    }
    return null;
  }
  function candidates(list, entry, states) {
    return list.filter(function (s) {
      if (handled(states[s.id])) return false;
      if (entry === "invite") return !!(s.triggers && s.triggers.invite);
      return !!(s.triggers && (s.triggers.events || []).indexOf(entry) >= 0);
    });
  }
  function pickWeighted(list, rand) {
    var total = list.reduce(function (n, s) { return n + (s.weight > 0 ? s.weight : 1); }, 0), x = (rand || Math.random)() * total;
    for (var i = 0; i < list.length; i++) { x -= list[i].weight > 0 ? list[i].weight : 1; if (x < 0) return list[i]; }
    return list[list.length - 1];
  }

  // 同一時間只處理一個 begin（多個分頁同時觸發時，第二個看到第一個寫進去的紀錄）
  var queue = Promise.resolve();
  function serial(fn) { var p = queue.then(fn, fn); queue = p.catch(function () {}); return p; }

  // 開始顯示問卷。opts：{ entry: invite|<事件>|announcement|console, surveyId?, lang, rand? }
  // → { ok, def, answers, order, responseId, entry, needTelemetryConsent } 或 { ok:false, reason: welcome|today|new_install|cooldown|none|ended|unavailable }
  function begin(opts) {
    return serial(function () { return beginNow(opts || {}); }).catch(function () { return { ok: false, reason: "unavailable" }; });
  }
  function beginNow(o) {
    var entry = o.entry, lang = BBSurveyCore.LANGS.indexOf(o.lang) >= 0 ? o.lang : "en", now = Date.now();
    var auto = AUTO.indexOf(entry) >= 0;
    if (!auto && entry !== "announcement" && entry !== "console") return Promise.resolve({ ok: false, reason: "unavailable" });
    var gateCheck = auto ? welcomeOpen() : Promise.resolve(false);
    return gateCheck.then(function (welcome) {
      if (welcome) return finishGate(entry, "welcome");
      return getStates().then(function (g) {
        var why = auto ? gate(entry, g, now) : null;
        if (why) return finishGate(entry, why);
        return getList(lang, !auto).then(function (list) {
          var survey;
          if (auto) {
            var cands = candidates(list, entry, g.states);
            if (!cands.length) return finishGate(entry, "none");
            survey = pickWeighted(cands, o.rand);
          } else if (o.surveyId) {
            // 公告、console：填過也能開（重填，送出後覆蓋伺服器上同一筆）；關掉過也照樣開
            survey = list.filter(function (s) { return s.id === o.surveyId; })[0];
            if (!survey) return { ok: false, reason: "ended" };
          } else {
            // 沒指定哪一份：先挑還沒填過的；都填過了就從全部挑一份（重填）
            if (!list.length) return { ok: false, reason: "ended" };
            var open = list.filter(function (s) { return !(g.states[s.id] && g.states[s.id].doneAt); });
            survey = pickWeighted(open.length ? open : list, o.rand);
          }
          return show(survey, entry, lang, g, now, auto);
        });
      });
    });
  }
  function finishGate(entry, result) {
    if (AUTO.indexOf(entry) >= 0) track("/v2/surveys/triggers", { trigger: entry, result: result });
    return { ok: false, reason: result };
  }
  function show(survey, entry, lang, g, now, auto) {
    var states = g.states, st = Object.assign({}, states[survey.id] || {});
    // 重填（填過的從公告打開）沿用同一個 responseId（可能來自 sync）；送出完成時答案已經清掉，所以從空白開始。
    // 選項順序沒有（第一次在這台出現，或 sync 來的紀錄）就在這裡決定
    if (!st.responseId) { st.responseId = randomHex(16); st.answers = {}; }
    if (!st.answers || typeof st.answers !== "object") st.answers = {};
    if (!st.order || typeof st.order !== "object") {
      st.order = {};
      survey.questions.forEach(function (q) { if (q.shuffle) st.order[q.id] = BBSurveyCore.optionOrder(survey, q); });
    }
    st.shownAt = now;
    states[survey.id] = st;
    var extra = {}; extra[SHOWN_KEY] = { day: localDay(now), id: survey.id };
    return putStates(states, extra).then(function () {
      if (auto) track("/v2/surveys/triggers", { trigger: entry, result: "shown" });
      return clientInfo(lang).then(function (client) {
        track("/v2/surveys/events", { survey_id: survey.id, response_id: st.responseId, kind: "shown", entry: entry, client: client });
        return fxHas(["technicalAndInteraction"]).then(function (has) {
          return { ok: true, def: survey, answers: st.answers || {}, order: st.order || {}, responseId: st.responseId, entry: entry, needTelemetryConsent: isFirefox() && !has };
        });
      });
    });
  }

  function installDays(installedAt) {
    if (!installedAt) return "gt90";
    var d = (Date.now() - installedAt) / 86400000;
    return d < 7 ? "lt7" : d < 30 ? "7_30" : d < 90 ? "30_90" : "gt90";
  }
  function clientInfo(lang) {
    return get(["installedAt", "cdnMode", "customHosts"]).then(function (items) {
      return {
        browser: browserName(), ext_version: extVersion(), lang: BBSurveyCore.LANGS.indexOf(lang) >= 0 ? lang : "en", install_days: installDays(items.installedAt),
        custom_nodes: items.cdnMode === "custom" || (Array.isArray(items.customHosts) && items.customHosts.length > 0)
      };
    });
  }
  function surveyFromList(id) {
    return get(LIST_KEY).then(function (s) { var l = s[LIST_KEY]; return ((l && l.surveys) || []).filter(function (x) { return x.id === id; })[0] || null; });
  }

  // 換頁（離開一頁時）：opts { surveyId, entry, lang, page, question, ms }
  function pageEvent(opts) {
    return getStates().then(function (g) {
      var st = g.states[opts.surveyId];
      if (!st || !st.responseId) return { ok: false };
      return clientInfo(opts.lang).then(function (client) {
        track("/v2/surveys/events", { survey_id: opts.surveyId, response_id: st.responseId, kind: "page", page: opts.page, question: opts.question, ms: opts.ms, entry: opts.entry, client: client });
        return { ok: true };
      });
    });
  }
  // 使用者按 × 或 Esc 關掉（沒填完）：這份不再自動出現，3 天冷卻從現在起算
  function closed(opts) {
    return getStates().then(function (g) {
      var st = g.states[opts.surveyId];
      if (!st || st.doneAt) return { ok: false };
      st.closedAt = Date.now();
      var extra = {}; extra[ENDED_KEY] = st.closedAt;
      return putStates(g.states, extra).then(function () {
        return clientInfo(opts.lang).then(function (client) {
          track("/v2/surveys/events", { survey_id: opts.surveyId, response_id: st.responseId, kind: "closed", page: opts.page, entry: opts.entry, client: client });
          return { ok: true };
        });
      });
    });
  }

  // 送出目前的所有答案。opts：{ surveyId, answers, final, entry, lang, telemetryConsent }。回 { ok } 或 { ok:false, reason }
  function submit(opts) {
    return Promise.all([getStates(), surveyFromList(opts.surveyId), clientInfo(opts.lang)]).then(function (arr) {
      var g = arr[0], def = arr[1], client = arr[2], st = g.states[opts.surveyId];
      if (!def || !st || !st.responseId) return { ok: false, reason: "unavailable" };
      var answers = {};
      // 只送目前路徑上的題目（流程圖：回頭改答案換了一條路，原本那條路上的答案不送），值留給伺服器驗證
      var onPath = BBSurveyCore.pathIds(def, opts.answers || {});
      def.questions.forEach(function (q) {
        var v = opts.answers && opts.answers[q.id];
        if (onPath.indexOf(q.id) < 0) return;
        if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) answers[q.id] = v;
      });
      var emailQ = def.questions.filter(function (q) { return q.type === "email"; })[0];
      var hasEmail = !!(emailQ && answers[emailQ.id]);
      var need = [];
      if (opts.final && opts.telemetryConsent) need.push("technicalAndInteraction");
      if (hasEmail) need.push("personallyIdentifyingInfo");
      // Firefox：Email 屬於 personallyIdentifyingInfo。沒有（或被拒絕）這個權限就不送 Email，其他答案照送
      var perms = opts.final ? fxRequest(need) : fxHas(hasEmail ? ["personallyIdentifyingInfo"] : []);
      return perms.then(function (ok) {
        if (!ok && hasEmail && isFirefox()) {
          return fxHas(["personallyIdentifyingInfo"]).then(function (hasPii) { if (!hasPii) delete answers[emailQ.id]; });
        }
      }).then(function () {
        var entry = BBSurveyCore.ENTRIES.indexOf(opts.entry) >= 0 ? opts.entry : "announcement";
        var body = { survey_id: opts.surveyId, response_id: st.responseId, answers: answers, final: !!opts.final, entry: entry, client: client };
        return postJson("/v2/surveys/responses", body).then(function (r) {
          if (!r) return { ok: false, reason: "network" };
          if (r.status === 404) return { ok: false, reason: "gone" };
          if (r.status === 429) return { ok: false, reason: "rate_limited" };
          if (!r.ok) return { ok: false, reason: "server" };
          return getStates().then(function (g2) {
            var s2 = g2.states[opts.surveyId] || st, extra = {};
            if (opts.final) {
              s2.doneAt = Date.now(); s2.answers = {};
              extra[ENDED_KEY] = s2.doneAt;
              track("/v2/surveys/events", { survey_id: opts.surveyId, response_id: st.responseId, kind: "completed", entry: entry, client: client });
            } else s2.answers = answers;
            g2.states[opts.surveyId] = s2;
            return putStates(g2.states, extra).then(function () {
              // 填過的紀錄同步到其他電腦（失敗不影響這次送出）
              if (opts.final) return syncMarkDone(opts.surveyId, s2.doneAt, st.responseId).then(function () { return { ok: true }; }, function () { return { ok: true }; });
              return { ok: true };
            });
          });
        });
      });
    }).catch(function () { return { ok: false, reason: "error" }; });
  }

  // 測試用（bbSurvey({ reset: true })）：清掉本機的問卷紀錄與 sync 裡填過的紀錄；surveyState、surveyDef 是單一問卷時期的舊紀錄
  function reset() {
    var local = new Promise(function (r) { chrome.storage.local.remove([LIST_KEY, STATES_KEY, ENDED_KEY, SHOWN_KEY, "surveyState", "surveyDef"], function () { void chrome.runtime.lastError; r(); }); });
    return Promise.all([local, syncCall(function (a, cb) { return a.remove(SYNC_KEY, cb); })]).then(function () {});
  }
  function dropListCache() { return new Promise(function (r) { chrome.storage.local.remove([LIST_KEY], function () { void chrome.runtime.lastError; r(); }); }); }

  var out = {
    begin: begin, submit: submit, pageEvent: pageEvent, closed: closed, heartbeat: heartbeat, blocked: blocked, getList: getList, getStates: getStates,
    reset: reset, dropListCache: dropListCache, installDays: installDays, localDay: localDay, gate: gate, candidates: candidates, pickWeighted: pickWeighted,
    SAMPLE_RATE: SAMPLE_RATE, LIST_KEY: LIST_KEY, STATES_KEY: STATES_KEY, ENDED_KEY: ENDED_KEY, SHOWN_KEY: SHOWN_KEY, SYNC_KEY: SYNC_KEY, SYNC_MAX: SYNC_MAX
  };
  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("survey", out);
  return out;
})();
