// 雲端備份：帳號跟 BiBoost 手機 App 共用（api.biboost.app 的 /auth/*、/me、/me/settings，後台在 biboost-mobile 的 api-worker）。
// background、popup、歡迎頁、登入回跳頁（auth.html）共用。規格：spec/cloud-sync.md。
//
// 登入（只有 Google）：<API>/auth/oauth/google/start?state&return=<本擴充的 auth.html>&code_challenge（PKCE, S256）
//   → Google → 伺服器 callback → 導回 auth.html?code&state → POST /auth/oauth/exchange {code, state, code_verifier} 換 token。
//   在哪裡開：歡迎頁（小視窗）直接在同一個視窗換頁，登入完 auth.html 再換回歡迎頁，整個過程只有一個視窗（使用者回饋：登入完出現兩個歡迎頁）；
//   popup 開一個小視窗（跟問題回報一樣），登入完在那個視窗裡顯示雲端備份面板。
//   不用瀏覽器的 identity API（要多一個權限、Safari 沒有）；auth.html 在 manifest 的 web_accessible_resources 開給 api.biboost.app。
//   PKCE：只有發起登入的這個擴充知道 code_verifier，別人攔到 code 也換不到 token。
// 備份內容（命名空間，見 biboost-mobile/specs/cloud-backup.md）：
//   shared：customHosts（自訂節點列表，跟 App 共用）
//   extension：EXT_FIELDS（設定、目前節點與國家、問題回報紀錄）
//   上傳時保留雲端上這份裡本擴充不認得的欄位（新版本或 App 加的），只蓋掉自己的欄位。
// 兩種用法（使用者在雲端備份視窗自選）：
//   手動：「備份到雲端」「從雲端恢復設定」兩顆按鈕。
//   自動同步（單向）：打開時先整份備份一次，之後 background 監看設定變動，2 秒後把改了的欄位上傳。不會從雲端拉回來，
//     別台的設定要靠「從雲端恢復設定」拿（使用者決定：自動同步＝本機改動即時同步到雲端，不是定時雙向同步）。
//     目前節點與國家也一起上傳（使用者決定：自動備份就是隨時備份一切）。兩台同時改不同欄位都保留（rev 樂觀鎖＋欄位層級合併）。
// storage.local：
//   cloudAccount = { api, token, email }：登入狀態（token 沒有到期日，登出時作廢）
//   cloudAuthPending = { api, state, verifier, t, back }：登入進行中（auth.html 驗 state、拿 verifier 換 token；back＝登入完要換回去的擴充頁面，例如 welcome.html）
//   cloudSync = { auto, rev: { ns: n }, snap: { 欄位: JSON }, dirty: [欄位], lastUp, lastDown, lastErr }
//   cloudAppliedAt：還原（從雲端恢復設定）寫進本機的時間；popup 開著時看到它變了就重新載入，畫面才會是新的設定
var BBCloud = (function () {
  var API = { prod: "https://api.biboost.app", dev: "https://api-staging.biboost.app" };
  var EXT_FIELDS = ["enabled", "cdnMode", "cdnCountry", "cdnHost", "videoEnabled", "liveEnabled", "liveRoute", "autoFallback", "showDebug", "sortBySpeed",
    "stVideoMb", "stVideoSec", "stLiveRuns", "stLiveSec", "stVideoPreset", "stLivePreset", "uiLang", "uiTheme", "reportHistory"];
  var SHARED_FIELDS = ["customHosts"];
  var NS_OF = {};
  EXT_FIELDS.forEach(function (k) { NS_OF[k] = "extension"; });
  SHARED_FIELDS.forEach(function (k) { NS_OF[k] = "shared"; });
  var CLIENT = "extension";
  var PUSH_DELAY_MS = 2000;
  var PENDING_MAX_MS = 30 * 60 * 1000;

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, function (s) { r(s || {}); }); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, function () { r(); }); }); }
  function remove(keys) { return new Promise(function (r) { chrome.storage.local.remove(keys, function () { r(); }); }); }
  var J = function (v) { return JSON.stringify(v === undefined ? null : v); };

  var apiPromise = null;
  function apiBase() {
    apiPromise = apiPromise || new Promise(function (resolve) {
      try { chrome.management.getSelf(function (self) { resolve(self && self.installType === "development" ? API.dev : API.prod); }); }
      catch (e) { resolve(API.prod); }
    });
    return apiPromise;
  }

  function CloudError(code, status) { var e = new Error(code); e.code = code; e.status = status || 0; return e; }

  // ---- 帳號 ----
  function account() {
    return Promise.all([apiBase(), get("cloudAccount")]).then(function (a) {
      var acc = a[1].cloudAccount;
      return acc && acc.token && acc.api === a[0] ? acc : null;
    });
  }
  function request(method, path, body, token) {
    return apiBase().then(function (api) {
      var headers = {};
      if (token) headers.Authorization = "Bearer " + token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return fetch(api + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", cache: "no-store" })
        .catch(function () { throw CloudError("network"); })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (r.ok) return j;
            if (r.status === 401) return remove("cloudAccount").then(function () { throw CloudError("unauthorized", 401); });
            var err = CloudError((j && j.error) || "http_" + r.status, r.status);
            err.body = j;
            throw err;
          });
        });
    });
  }
  function authed(method, path, body) {
    return account().then(function (acc) {
      if (!acc) throw CloudError("not_logged_in");
      return request(method, path, body, acc.token);
    });
  }

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function challengeOf(verifier) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (h) { return b64url(new Uint8Array(h)); });
  }
  // 登入網址：state 與 PKCE verifier 先存起來，auth.html 回來時用
  function loginUrl(back) {
    var state = randomString(24), verifier = randomString(48);
    return Promise.all([apiBase(), challengeOf(verifier)]).then(function (a) {
      var api = a[0], pending = { api: api, state: state, verifier: verifier, t: Date.now() };
      if (back) pending.back = back;
      return set({ cloudAuthPending: pending }).then(function () {
        var q = "state=" + encodeURIComponent(state) + "&return=" + encodeURIComponent(chrome.runtime.getURL("auth.html")) +
          "&code_challenge=" + encodeURIComponent(a[1]) + "&code_challenge_method=S256";
        return api + "/auth/oauth/google/start?" + q;
      });
    });
  }
  // opts.back：在目前這一頁換頁登入，登入完 auth.html 換回這個擴充頁面（歡迎頁用）。沒有 back 就開一個小視窗（沒有視窗 API 的環境開新分頁）
  var LOGIN_W = 500, LOGIN_H = 720;
  function startLogin(opts) {
    var back = opts && opts.back;
    return loginUrl(back).then(function (url) {
      if (back) { location.href = url; return url; }
      return new Promise(function (r) {
        function tab() { chrome.tabs.create({ url: url }, function () { void chrome.runtime.lastError; r(url); }); }
        try {
          if (chrome.windows && chrome.windows.create) {
            chrome.windows.create({ url: url, type: "popup", width: LOGIN_W, height: LOGIN_H, focused: true }, function () {
              if (chrome.runtime.lastError) tab(); else r(url);
            });
            return;
          }
        } catch (e) {}
        tab();
      });
    });
  }
  // auth.html：網址上的 { code, state, error } → 換 token、存帳號。回傳 { email, back }
  function finishLogin(params) {
    return get("cloudAuthPending").then(function (s) {
      var p = s.cloudAuthPending;
      if (params.error) throw CloudError(params.error);
      if (!p || !params.code || params.state !== p.state || Date.now() - p.t > PENDING_MAX_MS) throw CloudError("bad_state");
      return remove("cloudAuthPending")
        .then(function () { return request("POST", "/auth/oauth/exchange", { code: params.code, state: params.state, code_verifier: p.verifier }); })
        .then(function (j) {
          if (!j || !j.token) throw CloudError("bad_response");
          var email = (j.account && j.account.email) || j.email || "";
          return set({ cloudAccount: { api: p.api, token: j.token, email: email } }).then(function () {
            if (email) return email;
            return authed("GET", "/me").then(function (me) {
              return set({ cloudAccount: { api: p.api, token: j.token, email: me.email || "" } }).then(function () { return me.email || ""; });
            }).catch(function () { return ""; });
          });
        })
        .then(function (email) { return { email: email, back: p.back || "" }; });
    });
  }
  function logout() {
    return account().then(function (acc) {
      var done = function () { return Promise.all([remove(["cloudAccount", "cloudAuthPending"]), get("cloudSync").then(function (s) {
        var c = s.cloudSync || {};
        return set({ cloudSync: { auto: false, rev: {}, snap: {}, dirty: [], lastUp: c.lastUp || 0, lastDown: c.lastDown || 0 } });
      })]); };
      if (!acc) return done();
      return request("POST", "/auth/logout", {}, acc.token).catch(function () {}).then(done);
    });
  }

  // ---- 備份內容 ----
  function syncState() {
    return get("cloudSync").then(function (s) {
      var c = s.cloudSync || {};
      return { auto: !!c.auto, rev: c.rev || {}, snap: c.snap || {}, dirty: c.dirty || [], lastUp: c.lastUp || 0, lastDown: c.lastDown || 0, lastErr: c.lastErr || "" };
    });
  }
  function saveSync(c) { return set({ cloudSync: c }); }
  // 本機設定 → { shared, extension }（只放 storage 裡有的欄位）
  function collect(fields) {
    fields = fields || EXT_FIELDS.concat(SHARED_FIELDS);
    return get(fields).then(function (items) {
      var out = { shared: {}, extension: {} };
      fields.forEach(function (k) { if (items[k] !== undefined) out[NS_OF[k]][k] = items[k]; });
      return out;
    });
  }
  function docs() { return authed("GET", "/me/settings"); }
  function docOf(all, ns) { var d = all && all[ns]; return d && typeof d === "object" ? { data: d.data || {}, rev: d.rev || 0, updatedAt: d.updatedAt || 0, updatedBy: d.updatedBy || "" } : { data: {}, rev: 0, updatedAt: 0, updatedBy: "" }; }
  // 把 fields 寫進雲端的 ns、drop 裡的欄位從雲端刪掉（本機沒存值＝預設值，不刪的話之前備份的舊值會一直留著、還原時又被拿回來）。
  // 以雲端目前那份為底（保留不認得的欄位），409 就拿最新的再蓋一次（最多 3 次）
  function putMerged(ns, base, fields, drop) {
    var tries = 0;
    function attempt(cur) {
      var data = {};
      for (var k in cur.data) data[k] = cur.data[k];
      (drop || []).forEach(function (d) { delete data[d]; });
      for (var k2 in fields) data[k2] = fields[k2];
      return authed("PUT", "/me/settings/" + ns, { data: data, baseRev: cur.rev, client: CLIENT }).catch(function (e) {
        if (e.code === "conflict" && e.body && ++tries < 3) return attempt(docOf({ x: e.body.current }, "x"));
        throw e;
      });
    }
    return attempt(base);
  }
  // 雲端上次備份的摘要（視窗顯示「上次備份：時間、哪個用戶端」）
  function lastBackup(all) {
    var e = docOf(all, "extension"), s = docOf(all, "shared");
    var newest = e.updatedAt >= s.updatedAt ? e : s;
    // 被清空（data 是空的）也算沒有備份：還原時會是 no_backup
    var any = Object.keys(e.data).length || Object.keys(s.data).length;
    return newest.rev && any ? { at: newest.updatedAt, by: newest.updatedBy } : null;
  }
  function status() {
    return Promise.all([account(), syncState()]).then(function (a) { return { account: a[0], sync: a[1] }; });
  }
  function remoteInfo() { return docs().then(function (all) { return { last: lastBackup(all) }; }); }

  // 本擴充認得、但這次沒有值的欄位（ns 裡）
  function missing(ns, have) { return (ns === "shared" ? SHARED_FIELDS : EXT_FIELDS).filter(function (k) { return have[k] === undefined; }); }
  // 手動「備份到雲端」：本機的全部欄位蓋掉雲端（本機是預設值、沒存的欄位從雲端刪掉）
  function backup() {
    return Promise.all([docs(), collect(), syncState()]).then(function (a) {
      var all = a[0], local = a[1], c = a[2];
      return putMerged("shared", docOf(all, "shared"), local.shared, missing("shared", local.shared))
        .then(function (sh) { return putMerged("extension", docOf(all, "extension"), local.extension, missing("extension", local.extension)).then(function (ex) { return [sh, ex]; }); })
        .then(function (r) {
          c.rev = { shared: r[0].rev, extension: r[1].rev };
          c.snap = snapOf(local);
          c.dirty = [];
          c.lastUp = Date.now();
          c.lastErr = "";
          return saveSync(c).then(function () { return { at: c.lastUp }; });
        });
    });
  }
  function snapOf(local) {
    var snap = {};
    ["shared", "extension"].forEach(function (ns) { for (var k in local[ns]) snap[k] = J(local[ns][k]); });
    return snap;
  }
  // 雲端的欄位 → storage 的 patch（只收本擴充認得、型別合理的欄位）
  function patchFrom(all, skip) {
    var patch = {};
    [["shared", SHARED_FIELDS], ["extension", EXT_FIELDS]].forEach(function (p) {
      var data = docOf(all, p[0]).data;
      p[1].forEach(function (k) {
        if (skip && skip.indexOf(k) >= 0) return;
        if (data[k] === undefined || data[k] === null && k !== "cdnCountry") return;
        if ((k === "customHosts" || k === "reportHistory") && !Array.isArray(data[k])) return;
        patch[k] = data[k];
      });
    });
    return patch;
  }
  // 手動「從雲端恢復設定」：雲端的欄位整份蓋掉本機；雲端那份有備份、但沒有的欄位＝備份那台是預設值，本機也刪掉回到預設。
  // 還原＝不是新使用者：不再依 IP 選國家（countryAutoDone）、安裝後的自動優化取消（installTestPending）
  function restore() {
    return Promise.all([docs(), syncState()]).then(function (a) {
      var all = a[0], c = a[1];
      var patch = patchFrom(all);
      if (!Object.keys(patch).length) throw CloudError("no_backup");
      var clear = [];
      // 看雲端的資料、不看 patch：格式不對而沒收的欄位（雲端有值）不算
      ["shared", "extension"].forEach(function (ns) { var d = docOf(all, ns); if (d.rev) clear = clear.concat(missing(ns, d.data)); });
      applyUiPrefs(patch, clear);
      patch.countryAutoDone = true;
      patch.installTestPending = false;
      patch.cloudAppliedAt = Date.now();
      if (typeof patch.cdnMode === "string" && patch.cdnMode !== "custom" && patch.cdnMode !== "list") delete patch.cdnMode;
      var snap = {};
      for (var k in patch) if (NS_OF[k]) snap[k] = J(patch[k]);
      c.snap = snap;
      c.rev = { shared: docOf(all, "shared").rev, extension: docOf(all, "extension").rev };
      c.dirty = [];
      c.lastDown = Date.now();
      c.lastErr = "";
      // 先存同步狀態（snap＝還原後的值）再寫設定：自動同步開著時，background 看到的變動跟 snap 一樣，不會再傳回去
      clear.forEach(function (k) { c.snap[k] = J(undefined); });
      return remove("cdnListPending").then(function () { return saveSync(c); }).then(function () { return remove(clear); }).then(function () { return set(patch); }).then(function () { return { fields: Object.keys(patch).length }; });
    });
  }
  // 語言、主題：popup／歡迎頁有 i18n.js、theme.js 時順便寫進它們的 localStorage 與 uiMsgs（bridge 頁內提示用）；
  // 背景（自動同步）只寫 storage，popup 下次打開時以 storage 為準（popup.js 的比對）
  // clear：要回到預設的欄位（語言＝跟隨瀏覽器、主題＝跟隨系統）
  function applyUiPrefs(patch, clear) {
    clear = clear || [];
    if (clear.indexOf("uiLang") >= 0) { patch.uiMsgs = null; if (typeof window !== "undefined" && typeof window.setUiLangPref === "function") try { window.setUiLangPref("auto"); } catch (e) {} }
    if (clear.indexOf("uiTheme") >= 0 && typeof window !== "undefined" && typeof window.setUiTheme === "function") try { window.setUiTheme("system"); } catch (e) {}
    if (typeof patch.uiLang === "string") {
      if (typeof window !== "undefined" && typeof window.uiMessagesFor === "function") {
        try { patch.uiMsgs = window.uiMessagesFor(patch.uiLang); window.setUiLangPref(patch.uiLang); } catch (e) {}
      }
    }
    if (typeof patch.uiTheme === "string" && typeof window !== "undefined" && typeof window.setUiTheme === "function") {
      try { window.setUiTheme(patch.uiTheme); } catch (e) {}
    }
  }

  // ---- 自動同步（background）：單向，本機一改就上傳到雲端 ----
  // 不會從雲端拉回來（使用者決定：自動同步＝把本機的改動即時同步到雲端）。要拿雲端的設定用「從雲端恢復設定」（restore）。
  var AUTO_FIELDS = EXT_FIELDS.concat(SHARED_FIELDS);
  var pushTimer = null;
  var chain = Promise.resolve(); // 上傳一律排隊，不同時進行
  function queue(fn) { var p = chain.then(fn, fn); chain = p.catch(function () {}); return p; }

  // 打開自動同步：先把本機目前的設定整份備份上去（之後只送改了的欄位）；備份失敗就維持關閉
  function setAuto(on) {
    return syncState().then(function (c) {
      c.auto = !!on;
      c.dirty = [];
      return saveSync(c);
    }).then(function () {
      if (!on) return;
      return queue(backup).catch(function (e) {
        return syncState().then(function (c) { c.auto = false; return saveSync(c); }).then(function () { throw e; });
      });
    });
  }
  // storage 變動（background 的 onChanged）→ 跟上次上傳的值不同的欄位記成 dirty，2 秒後上傳
  function onLocalChange(changes) {
    var keys = Object.keys(changes).filter(function (k) { return AUTO_FIELDS.indexOf(k) >= 0; });
    if (!keys.length) return Promise.resolve(false);
    return Promise.all([syncState(), account()]).then(function (a) {
      var c = a[0];
      if (!c.auto || !a[1]) return false;
      var changed = keys.filter(function (k) { return J(changes[k].newValue) !== c.snap[k]; });
      if (!changed.length) return false;
      changed.forEach(function (k) { if (c.dirty.indexOf(k) < 0) c.dirty.push(k); });
      return saveSync(c).then(function () {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(function () { pushTimer = null; push(); }, PUSH_DELAY_MS);
        return true;
      });
    });
  }
  // 上傳 dirty 欄位：以雲端目前那份為底（保留別台、App 的欄位），只蓋掉改了的欄位
  function push() {
    return queue(function () {
      return Promise.all([syncState(), account()]).then(function (a) {
        var c = a[0];
        if (!c.auto || !a[1] || !c.dirty.length) return;
        var dirty = c.dirty.slice();
        return Promise.all([docs(), get(dirty)]).then(function (b) {
          // 被刪掉的欄位（例如「恢復原始設置」）也要從雲端刪掉
          var all = b[0], items = b[1], byNs = { shared: {}, extension: {} }, gone = { shared: [], extension: [] };
          dirty.forEach(function (k) { if (items[k] !== undefined) byNs[NS_OF[k]][k] = items[k]; else gone[NS_OF[k]].push(k); });
          var jobs = ["shared", "extension"].filter(function (ns) { return Object.keys(byNs[ns]).length || gone[ns].length; });
          return jobs.reduce(function (p, ns) {
            return p.then(function () {
              return putMerged(ns, docOf(all, ns), byNs[ns], gone[ns]).then(function (d) {
                c.rev[ns] = d.rev;
                for (var k in byNs[ns]) c.snap[k] = J(byNs[ns][k]);
                gone[ns].forEach(function (g) { c.snap[g] = J(undefined); });
              });
            });
          }, Promise.resolve()).then(function () {
            return syncState().then(function (now) {
              // 上傳期間又改了的欄位留著，下一輪再送
              now.dirty = now.dirty.filter(function (k) { return dirty.indexOf(k) < 0 || J(items[k]) !== c.snap[k]; });
              now.rev = c.rev; for (var k in c.snap) now.snap[k] = c.snap[k];
              now.lastUp = Date.now(); now.lastErr = "";
              return saveSync(now).then(function () { if (now.dirty.length) setTimeout(push, PUSH_DELAY_MS); });
            });
          });
        }).catch(function (e) { return syncState().then(function (now) { now.lastErr = e.code || "error"; return saveSync(now); }); });
      });
    });
  }
  // background 呼叫一次：接上 storage 變動；service worker 被收掉前還沒送出的改動，醒來時補送
  function attachBackground() {
    chrome.storage.onChanged.addListener(function (changes, area) { if (area === "local") onLocalChange(changes); });
    push();
  }

  var api = {
    apiBase: apiBase, account: account, status: status, loginUrl: loginUrl, startLogin: startLogin, finishLogin: finishLogin, logout: logout,
    remoteInfo: remoteInfo, backup: backup, restore: restore, setAuto: setAuto, push: push, onLocalChange: onLocalChange, attachBackground: attachBackground,
    collect: collect, patchFrom: patchFrom, lastBackup: lastBackup, challengeOf: challengeOf,
    EXT_FIELDS: EXT_FIELDS, SHARED_FIELDS: SHARED_FIELDS, PUSH_DELAY_MS: PUSH_DELAY_MS
  };
  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("cloud", api);
  return api;
})();
