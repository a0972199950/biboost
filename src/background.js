/**
 * 背景腳本：
 *  1) 更新時補記「從哪個版本升上來」
 *  2) 收下測速工具（CDNSpeedTest.exe）推薦的節點，接到「自訂節點列表」後面（見 bridge.js 的匯入網址）
 *  3) 問題回報用的診斷日誌：收 bridge / popup 送來的事件、採樣與快照，單一寫入者序列化寫進 storage.session，
 *     回報頁（report.html）送出時讀取。關瀏覽器就清空；只保留最近 10 分鐘。
 *  4) popup 按「問題回報」時開獨立視窗顯示回報頁（沒有視窗 API 的環境退回新分頁）
 *  5) 依 IP 選國家與該國第一個節點：全新安裝時（並標記「第一支影片在背景優化一次」installTestPending，見 main-hook.js）、
 *     安裝時沒查到 IP 而第一次打開 B 站頁面時（bridge.js 要求）、更新時替從沒選過節點的人補選
 *  6) 節點清單（伺服器下發，見 cdn-list.js）：安裝／更新時馬上去拿；拿不到就每分鐘重試，拿到才跑 5)。
 *     沒有清單時擴充不啟用（bridge.js）。之後 B 站頁面或 popup 打開時檢查新版本（6 小時內不重問），
 *     有新版本就替用國家清單的人更新卡頓時要測的節點（autoSpeedHosts）；使用者正在用的節點不動
 *  7) 雲端備份（cloud.js）的自動同步；全新安裝時的歡迎頁（一律開；雲端備份那塊由歡迎頁自己看功能開關）
 *  8) 新舊版首頁（實驗性）：改 B 站的兩個站點偏好 cookie，見下方 HV_*
 *
 * 1) 1.5.x 以前不會記錄 installedVersion，popup 沒辦法分辨「舊使用者剛更新」與「全新安裝」。
 * 瀏覽器在更新時會把 previousVersion 帶進 onInstalled，不用舊版配合，這裡把它補寫成 installedVersion，
 * popup 的 checkVersionUpdate() 就會把 (previousVersion, 目前版本] 之間的更新內容彈出來。
 * 全新安裝（reason = install）不處理，維持「新使用者不彈」。
 */
// Chrome／Safari 的 background 是 service worker，要自己載入；Firefox 在 manifest 的 background.scripts 裡已經先載入
if (typeof BBCdnList === "undefined" && typeof importScripts === "function") importScripts("cdn-list.js", "features.js", "cloud.js");

// 7) 雲端備份（cloud.js）：自動同步在這裡跑（監看設定變動、上傳到雲端）
BBCloud.attachBackground();
// 全新安裝開歡迎頁（小視窗，跟問題回報一樣）。雲端備份那塊只在功能開關 cloud_sync 開著時出現（welcome.js）
function openWelcome() {
  openExtWindow(chrome.runtime.getURL("welcome.html"), 500, 700);
}
// 歡迎頁按「開始使用」：關掉歡迎視窗，在一般視窗打開擴充的 popup 一次。
// action.openPopup：Chrome 127 起不用政策安裝也能呼叫；Firefox 要使用者手勢、其他環境沒有 → 打不開就算了
function finishWelcome(windowId) {
  var close = windowId != null && chrome.windows && chrome.windows.remove
    ? new Promise(function (r) { chrome.windows.remove(windowId, function () { void chrome.runtime.lastError; r(); }); })
    : Promise.resolve();
  return close.then(function () {
    if (!chrome.action || typeof chrome.action.openPopup !== "function" || !chrome.windows) return;
    return new Promise(function (r) {
      chrome.windows.getLastFocused({ windowTypes: ["normal"] }, function (w) {
        void chrome.runtime.lastError;
        if (!w) return r();
        chrome.windows.update(w.id, { focused: true }, function () {
          void chrome.runtime.lastError;
          try { Promise.resolve(chrome.action.openPopup({ windowId: w.id })).catch(function () {}).then(r); } catch (e) { r(); }
        });
      });
    });
  });
}

// 從 popup 登入（cloud.js 的 startLogin 開的小視窗）完成：auth.html 送 CDN_SWITCHER_LOGIN_DONE。
// 關掉登入視窗（分頁），在一般視窗重新打開 popup，popup 看到 cloudOpenOnPopup 就打開雲端備份視窗——只留 popup 這一個。
// popup 本來就開著（例如固定在旁邊）就只關登入分頁，它自己會跟著登入狀態重畫。打不開 popup（Firefox 要使用者手勢等）回 false，
// auth.html 照舊在登入視窗裡顯示雲端備份面板
function loginDone(tabId) {
  function closeLoginTab() { if (tabId != null) chrome.tabs.remove(tabId, function () { void chrome.runtime.lastError; }); }
  if (!chrome.action || typeof chrome.action.openPopup !== "function" || !chrome.windows) return Promise.resolve(false);
  var popupOpen = chrome.runtime.getContexts
    ? Promise.resolve(chrome.runtime.getContexts({ contextTypes: ["POPUP"] })).then(function (c) { return !!(c && c.length); }, function () { return false; })
    : Promise.resolve(false);
  return popupOpen.then(function (open) {
    if (open) { closeLoginTab(); return true; }
    return new Promise(function (r) { chrome.storage.local.set({ cloudOpenOnPopup: Date.now() }, r); }).then(function () {
      return new Promise(function (r) {
        chrome.windows.getLastFocused({ windowTypes: ["normal"] }, function (w) {
          void chrome.runtime.lastError;
          if (!w) return r(false);
          chrome.windows.update(w.id, { focused: true }, function () {
            void chrome.runtime.lastError;
            Promise.resolve().then(function () { return chrome.action.openPopup({ windowId: w.id }); })
              .then(function () { closeLoginTab(); r(true); }, function () { r(false); });
          });
        });
      });
    }).then(function (ok) {
      if (!ok) chrome.storage.local.remove("cloudOpenOnPopup");
      return ok;
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === "install") {
    chrome.storage.local.set({ installedAt: Date.now(), installTestPending: true });
    whenListReady("install");
    openWelcome();
  }
  if (details.reason === "update") {
    chrome.storage.local.set({ updatedAt: Date.now() });
    // autoTestPending：2.8 以前「切換國家後測一次」的旗標，已由只在安裝時設的 installTestPending 取代
    chrome.storage.local.remove("autoTestPending");
    // autoSpeedSwitch：2.8 以前的「影片自動測速並切換到最快節點」，已併進「速度不佳時自動優化節點」（autoFallback）；開著它的人想要自動換節點
    chrome.storage.local.get({ autoSpeedSwitch: false }, function (items) {
      if (items.autoSpeedSwitch) chrome.storage.local.set({ autoFallback: true });
      chrome.storage.local.remove("autoSpeedSwitch");
    });
    whenListReady("update");
  }
  if (details.reason !== "update" || !details.previousVersion) return;
  chrome.storage.local.get("installedVersion", function (items) {
    // 已經有紀錄（1.6.0 起 popup 自己會寫）就不蓋掉；沒有才補上
    if (items && items.installedVersion) return;
    chrome.storage.local.set({ installedVersion: details.previousVersion });
  });
});

// 5) 以前要等使用者第一次打開 popup 才選國家（popup.js 的 autoSelectCountry），沒打開過的人一直停在全域預設節點。
//    reason：
//    - "install"：全新安裝。查不到 IP 也先放「其他地區」的清單，第一支影片的優化才有節點可測（countryAutoDone 不設，之後還會再查）
//    - "retry"：安裝時沒查到 IP，第一次打開 B 站頁面時 bridge.js 要求再查一次；只在安裝後的優化還沒跑（installTestPending）時做，
//      使用者自己選過節點、測過速就會清掉那個旗標，不會蓋掉使用者的選擇
//    - "update"：更新時替從沒選過節點的人補選。storage 裡沒有 cdnHost = 從來沒人寫過（只有使用者的動作或這裡會寫），用的一直是程式碼裡的預設
//    共同條件：popup 已經選過（countryAutoDone）或用自訂節點列表就不動。
//    B 站 zone API 的查法與存的欄位同 common.js 的 fetchZone（背景腳本沒有載入 common.js）
var ZONE_API = "https://api.bilibili.com/x/web-interface/zone";
var COUNTRY_FALLBACK = "OTHER"; // 同 popup.js：所在國家不在清單內時用「其他地區」
function fetchZoneData() {
  return fetch(ZONE_API, { credentials: "omit", cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || j.code !== 0 || !j.data) return null;
      var d = j.data;
      chrome.storage.local.set({ detectedIp: d.addr || "", detectedIsp: d.isp || "", detectedProvince: d.province || "", detectedCountryName: d.country || "", detectedDial: Number(d.country_code) || null, zoneCheckedAt: Date.now() });
      return d;
    })
    .catch(function () { return null; });
}
function selectCountry(reason) {
  return Promise.all([BBCdnList.load(), fetchZoneData()]).then(function (arr) {
    var data = arr[0] && arr[0].data, zone = arr[1];
    if (!data) return; // 還沒有清單：拿到時 whenListReady 會再跑
    if (!zone && reason !== "install") return;
    var countries = data.countries || [], known = {};
    (data.options || []).forEach(function (o) { if (o.value !== "backup") known[o.value] = true; });
    var code = "";
    if (zone) { var dial = Number(zone.country_code); countries.forEach(function (c) { if (c.dial === dial) code = c.code; }); }
    var target = code || COUNTRY_FALLBACK, hosts = [];
    countries.forEach(function (c) { if (c.code === target) hosts = c.nodes.filter(function (h) { return !!known[h]; }); });
    return new Promise(function (resolve) {
      chrome.storage.local.get(["countryAutoDone", "cdnMode", "cdnHost", "installTestPending"], function (items) {
        if (items.countryAutoDone === true || items.cdnMode === "custom" || !hosts.length ||
            (reason === "update" && "cdnHost" in items) || (reason === "retry" && !items.installTestPending)) { resolve(); return; }
        var patch = { cdnCountry: target, cdnMode: "list", cdnHost: hosts[0], autoSpeedHosts: hosts };
        if (zone) { patch.detectedCountry = code; patch.countryAutoDone = true; }
        chrome.storage.local.set(patch, resolve);
      });
    });
  }).catch(function () {});
}

// 6) 節點清單。reason：拿到清單後要跑的 selectCountry（"install"／"update"），記在 storage 的 cdnListPending，
//    service worker 中途被收掉、瀏覽器重開也不會忘
var LIST_RETRY_ALARM = "cdnListRetry";
var LIST_RETRY_MIN = 1; // 還沒拿到清單時每分鐘重試（Chrome 的 alarm 最短 30 秒，Safari／Firefox 保守用 1 分鐘）
var retryTimer = null;
function storageGet(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, function (s) { r(s || {}); }); }); }
function whenListReady(reason) {
  return new Promise(function (r) { chrome.storage.local.set({ cdnListPending: reason }, r); })
    .then(function () { return refreshList(true); });
}
function refreshList(force) {
  return BBCdnList.refresh(force).then(function (res) {
    if (!res.ok) { startListRetry(); return res; }
    stopListRetry();
    return afterList(res).then(function () { return res; });
  }).catch(function () { startListRetry(); return { ok: false, changed: false }; });
}
function afterList(res) {
  return storageGet("cdnListPending").then(function (items) {
    var pending = items.cdnListPending;
    if (!pending) return;
    return new Promise(function (r) { chrome.storage.local.remove("cdnListPending", r); }).then(function () { return selectCountry(pending); });
  }).then(function () { if (res.changed) return syncAutoSpeedHosts(res.data); });
}
// 新清單：用國家清單（沒選「全部」）的人，卡頓時要測的節點換成新清單裡該國的節點。目前使用的節點（cdnHost）不動
function syncAutoSpeedHosts(data) {
  return storageGet(["cdnMode", "cdnCountry", "autoSpeedHosts"]).then(function (items) {
    if (items.cdnMode === "custom" || !items.cdnCountry || items.cdnCountry === "ALL") return;
    var hosts = BBCdnList.countryHosts(data, items.cdnCountry);
    if (!hosts.length || (items.autoSpeedHosts || []).join("|") === hosts.join("|")) return;
    return new Promise(function (r) { chrome.storage.local.set({ autoSpeedHosts: hosts }, r); });
  });
}
function startListRetry() {
  if (chrome.alarms && chrome.alarms.create) { chrome.alarms.create(LIST_RETRY_ALARM, { delayInMinutes: LIST_RETRY_MIN, periodInMinutes: LIST_RETRY_MIN }); return; }
  if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; refreshList(true); }, LIST_RETRY_MIN * 60000);
}
function stopListRetry() {
  if (chrome.alarms && chrome.alarms.clear) chrome.alarms.clear(LIST_RETRY_ALARM, function () { void chrome.runtime.lastError; });
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (a) { if (a && a.name === LIST_RETRY_ALARM) refreshList(true); });
}
// 瀏覽器重開：還沒有清單（或還有沒跑完的選國家）就馬上再試
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () {
    Promise.all([BBCdnList.load(), storageGet("cdnListPending")]).then(function (arr) {
      if (!arr[0] || arr[1].cdnListPending) refreshList(true);
    });
  });
}

// 2) 匯入網址任何網站都能做出來，所以只收節點清單裡有的節點（測速工具測的也就是這份），
//    別人沒辦法藉此把影片導到自己的網域。已經在列表裡的不重複加，新的依序接在後面
function importCustomHosts(hosts) {
  return BBCdnList.load()
    .then(function (list) {
      if (!list) throw new Error("no node list");
      var data = list.data, known = {};
      (data.options || []).forEach(function (o) { if (o.value !== "backup") known[o.value] = true; });
      return new Promise(function (resolve) {
        chrome.storage.local.get({ customHosts: [], cdnMode: null, cdnHost: null }, function (items) {
          var list = Array.isArray(items.customHosts) ? items.customHosts.slice() : [];
          var added = 0;
          (Array.isArray(hosts) ? hosts : []).forEach(function (h) {
            if (typeof h !== "string" || !known[h] || list.indexOf(h) >= 0) return;
            list.push(h);
            added++;
          });
          var patch = { customHosts: list };
          // 已經選了自訂節點列表、但列表原本是空的（還在用原本的節點）→ 直接改用列表第一個
          if (items.cdnMode === "custom" && list.length && list.indexOf(items.cdnHost) < 0) patch.cdnHost = list[0];
          chrome.storage.local.set(patch, function () {
            resolve({ ok: true, added: added, total: list.length });
          });
        });
      });
    })
    .catch(function (e) { return { ok: false, err: String(e) }; });
}

// 3) 診斷日誌（問題回報用）
//    storage.session 關瀏覽器就清空，隱私上剛好；舊版 Safari 沒有 session 就退回 local（一樣只留 10 分鐘）。
//    所有寫入都走這裡的 promise chain 序列化，避免 bridge / popup 同時 read-modify-write 互相蓋掉。
var DIAG_STORE = chrome.storage.session || chrome.storage.local;
var DIAG_KEEP_MS = 10 * 60 * 1000;
var JOURNAL_MAX = 200;
var SAMPLES_MAX = 60;
var MERGE_WINDOW_MS = 30000; // 同類連續事件（如 403 洪水）合併成一筆，免得把前面的紀錄洗掉
var diagChain = Promise.resolve();

function diagGet(keys) { return new Promise(function (res) { DIAG_STORE.get(keys, function (items) { res(items || {}); }); }); }
function diagSet(obj) { return new Promise(function (res) { DIAG_STORE.set(obj, function () { void chrome.runtime.lastError; res(); }); }); }
function pruneOld(list, now) { return (list || []).filter(function (e) { return e && now - (e.until || e.t) < DIAG_KEEP_MS; }); }

function appendJournal(entry) {
  diagChain = diagChain.then(function () {
    return diagGet({ journal: [] }).then(function (items) {
      var now = Date.now();
      var list = pruneOld(items.journal, now);
      var last = list[list.length - 1];
      var sig = JSON.stringify(entry.d || {});
      if (last && last.k === entry.k && last.tab === entry.tab && last.sig === sig && now - (last.until || last.t) < MERGE_WINDOW_MS) {
        last.n = (last.n || 1) + 1; last.until = entry.t;
      } else {
        entry.sig = sig;
        list.push(entry);
      }
      if (list.length > JOURNAL_MAX) list = list.slice(list.length - JOURNAL_MAX);
      return diagSet({ journal: list });
    });
  }).catch(function () {});
  return diagChain;
}
function appendSample(row) {
  diagChain = diagChain.then(function () {
    return diagGet({ samples: [] }).then(function (items) {
      var list = pruneOld(items.samples, Date.now());
      list.push(row);
      if (list.length > SAMPLES_MAX) list = list.slice(list.length - SAMPLES_MAX);
      return diagSet({ samples: list });
    });
  }).catch(function () {});
  return diagChain;
}
// 每個 B 站分頁最近一次的 debug 快照：回報時目前分頁不是 B 站，就拿「最近更新的那一份」
function putSnapshot(tabId, snap) {
  diagChain = diagChain.then(function () {
    return diagGet({ snaps: {} }).then(function (items) {
      var now = Date.now(), snaps = {};
      for (var k in items.snaps || {}) if (now - items.snaps[k].t < DIAG_KEEP_MS) snaps[k] = items.snaps[k];
      snaps[String(tabId)] = snap;
      return diagSet({ snaps: snaps });
    });
  }).catch(function () {});
  return diagChain;
}

// 4) 回報頁一律開成獨立視窗（popup 按「問題回報」時）；?tab= 是按下時的 B 站分頁，沒有就不帶
function openReportWindow(tabId) {
  openExtWindow(chrome.runtime.getURL("report.html") + (tabId != null ? "?tab=" + tabId : ""), 760, 720);
}
// 公告視窗（announcement.html）：popup 的跑馬燈點下去開，?id= 是點到的那則公告（只顯示那一則）
function openAnnouncementWindow(id) {
  openExtWindow(chrome.runtime.getURL("announcement.html") + (/^\d+$/.test(String(id)) ? "?id=" + id : ""), 560, 680);
}
function openExtWindow(url, width, height) {
  try {
    if (chrome.windows && chrome.windows.create) {
      chrome.windows.create({ url: url, type: "popup", width: width, height: height, focused: true }, function () {
        if (chrome.runtime.lastError) chrome.tabs.create({ url: url }); // Firefox Android 等沒有視窗的環境
      });
      return;
    }
  } catch (e) {}
  chrome.tabs.create({ url: url });
}

// 交給其他 App 處理的網址（Mac App Store 的評論頁 macappstore://）：分頁本身不會載入任何東西，
// 系統接手後把留下的空白分頁關掉（popup 的「給我 5 星鼓勵」用）
function openHandoffUrl(url) {
  chrome.tabs.create({ url: url }, function (tab) {
    if (tab) setTimeout(function () { chrome.tabs.remove(tab.id, function () { void chrome.runtime.lastError; }); }, 2000);
  });
}

// 8) 新舊版首頁（實驗性）。
//    B 站把海外用戶的首頁換成「海外版」（沒有分區入口與輪播大圖），舊版是國內站首頁。
//    伺服器與頁面前端都看 B 站的兩個偏好 cookie 決定要不要把 / 導向海外版：
//      user_site     CN | OVERSEAS      使用者所在的站點
//      default_sites ["CN","OVERSEAS"]  帳號可用的站點（URL 編碼的 JSON 陣列）；只有 OVERSEAS 時，已登入的帳號會被導向海外版
//    舊版：user_site=CN、default_sites 含 CN；新版：user_site=OVERSEAS、default_sites 只有 OVERSEAS。
//    使用者選的值存在 storage 的 homeVersion（"old" | "new"），B 站之後把 cookie 改掉（登入、改版）時補回去。
//    沒選過（沒有 homeVersion）就完全不碰這兩個 cookie。
var HV_URL = "https://www.bilibili.com/";
var HV_DOMAIN = ".bilibili.com";
var HV_SITES = { old: { user_site: "CN", default_sites: ["CN", "OVERSEAS"] }, "new": { user_site: "OVERSEAS", default_sites: ["OVERSEAS"] } };
var HV_TTL_SEC = { user_site: 365 * 86400, default_sites: 180 * 86400 }; // 同 B 站自己寫的有效期限
var HV_ENFORCE_DELAY_MS = 500;
var HV_QUIET_MS = 1500; // 自己寫入後這段時間內的 cookie 變動不當成「被 B 站改掉」
var hvQuietUntil = 0;
var hvTimer = null;
function hvSupported() { return !!(chrome.cookies && chrome.cookies.get && chrome.cookies.set); }
function hvCookieGet(name) {
  return new Promise(function (resolve) {
    try {
      chrome.cookies.get({ url: HV_URL, name: name }, function (c) { void chrome.runtime.lastError; resolve(c ? c.value : null); });
    } catch (e) { resolve(null); }
  });
}
function hvCookieSet(name, value) {
  return new Promise(function (resolve) {
    try {
      chrome.cookies.set({ url: HV_URL, domain: HV_DOMAIN, path: "/", name: name, value: value, sameSite: "lax", expirationDate: Date.now() / 1000 + HV_TTL_SEC[name] }, function (c) {
        resolve(!chrome.runtime.lastError && !!c);
      });
    } catch (e) { resolve(false); }
  });
}
// cookie 值 → "old" | "new" | null（看不出來）
function hvDerive(userSite, defaultSites) {
  var sites = null;
  try { sites = JSON.parse(decodeURIComponent(defaultSites || "")); } catch (e) {}
  if (Array.isArray(sites) && sites.length) return sites.indexOf("CN") >= 0 ? "old" : "new";
  if (userSite === "CN") return "old";
  if (userSite === "OVERSEAS") return "new";
  return null;
}
function hvState() {
  if (!hvSupported()) return Promise.resolve(null);
  return Promise.all([hvCookieGet("user_site"), hvCookieGet("default_sites")]).then(function (v) { return hvDerive(v[0], v[1]); });
}
function hvApply(version) {
  var want = HV_SITES[version];
  if (!want || !hvSupported()) return Promise.resolve(false);
  hvQuietUntil = Date.now() + HV_QUIET_MS;
  return Promise.all([
    hvCookieSet("user_site", want.user_site),
    hvCookieSet("default_sites", encodeURIComponent(JSON.stringify(want.default_sites)))
  ]).then(function (r) { return r[0] && r[1]; });
}
// 使用者選過、而 cookie 對不上就補回去
function hvEnforce() {
  return storageGet("homeVersion").then(function (items) {
    var pref = items.homeVersion;
    if (pref !== "old" && pref !== "new") return;
    return hvState().then(function (state) { if (state !== pref) return hvApply(pref); });
  });
}
function hvInfo() {
  return Promise.all([storageGet("homeVersion"), hvState()]).then(function (r) {
    var pref = r[0].homeVersion;
    return { ok: true, supported: hvSupported(), pref: pref === "old" || pref === "new" ? pref : null, state: r[1] };
  });
}
function hvSet(version) {
  if (version !== "old" && version !== "new") return Promise.resolve({ ok: false, err: "bad version" });
  if (!hvSupported()) return Promise.resolve({ ok: false, err: "unsupported" });
  return hvApply(version).then(function (ok) {
    if (!ok) return { ok: false, err: "cookie" };
    return new Promise(function (r) { chrome.storage.local.set({ homeVersion: version }, r); }).then(function () { return { ok: true, pref: version, state: version }; });
  });
}
if (hvSupported() && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener(function (info) {
    var c = info && info.cookie;
    if (!c || info.removed || (c.name !== "user_site" && c.name !== "default_sites")) return;
    if (String(c.domain || "").replace(/^\./, "") !== "bilibili.com") return;
    if (Date.now() < hvQuietUntil) return;
    clearTimeout(hvTimer);
    hvTimer = setTimeout(hvEnforce, HV_ENFORCE_DELAY_MS);
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  var tabId = sender && sender.tab ? sender.tab.id : (msg.tab != null ? msg.tab : null);
  // popup 進階設定的「切換新舊版頁面」：GET 順便把被 B 站改掉的 cookie 補回去
  if (msg.type === "CDN_SWITCHER_HOME_VERSION_GET") { hvEnforce().then(hvInfo).then(sendResponse, function () { sendResponse({ ok: false }); }); return true; }
  if (msg.type === "CDN_SWITCHER_HOME_VERSION_SET") { hvSet(msg.version).then(sendResponse, function () { sendResponse({ ok: false }); }); return true; }
  if (msg.type === "CDN_SWITCHER_IMPORT_CUSTOM") { importCustomHosts(msg.hosts).then(sendResponse); return true; }
  if (msg.type === "CDN_SWITCHER_SELECT_COUNTRY") { selectCountry("retry").then(function () { sendResponse({ ok: true }); }); return true; }
  // bridge（B 站頁面）、popup 打開時：檢查有沒有新清單（6 小時內不重問）；force＝popup 遮罩的「重試」與每 10 秒的自動重試
  // 雲端備份：popup 的自動同步開關、popup 打開時拉一次（沒開自動同步就什麼都不做）
  if (msg.type === "CDN_SWITCHER_CLOUD_AUTO") { BBCloud.setAuto(!!msg.on).then(function () { sendResponse({ ok: true }); }, function (e) { sendResponse({ error: (e && e.code) || "error" }); }); return true; }
  if (msg.type === "CDN_SWITCHER_CDN_LIST") { refreshList(!!msg.force).then(function (r) { sendResponse({ ok: !!r.ok, changed: !!r.changed }); }); return true; }
  if (msg.type === "CDN_SWITCHER_JOURNAL" && msg.entry && typeof msg.entry.k === "string") {
    var e = { t: Number(msg.entry.t) || Date.now(), tab: tabId, k: msg.entry.k, d: msg.entry.d || {} };
    appendJournal(e).then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === "CDN_SWITCHER_SAMPLE" && msg.row) {
    var row = msg.row; row.tab = tabId; row.t = Number(row.t) || Date.now();
    appendSample(row).then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === "CDN_SWITCHER_SNAPSHOT" && msg.payload && tabId != null) {
    putSnapshot(tabId, { t: Date.now(), tab: tabId, url: msg.url || "", payload: msg.payload }).then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === "CDN_SWITCHER_OPEN_ANNOUNCEMENT_WINDOW") { openAnnouncementWindow(msg.id); sendResponse({ ok: true }); return true; }
  if (msg.type === "CDN_SWITCHER_OPEN_HANDOFF_URL" && /^macappstore:/.test(msg.url || "")) { openHandoffUrl(msg.url); sendResponse({ ok: true }); return true; }
  if (msg.type === "CDN_SWITCHER_LOGIN_DONE") { loginDone(sender && sender.tab ? sender.tab.id : null).then(function (ok) { sendResponse({ popup: ok }); }); return true; }
  if (msg.type === "CDN_SWITCHER_WELCOME_DONE") { finishWelcome(msg.windowId); sendResponse({ ok: true }); return true; }
  if (msg.type === "CDN_SWITCHER_OPEN_REPORT_WINDOW") { openReportWindow(msg.tab != null ? msg.tab : tabId); sendResponse({ ok: true }); return true; }
});

// Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") {
  globalThis.__BCS_TEST__.register("background", {
    importCustomHosts: importCustomHosts, selectCountry: selectCountry, whenListReady: whenListReady, refreshList: refreshList, syncAutoSpeedHosts: syncAutoSpeedHosts, LIST_RETRY_ALARM: LIST_RETRY_ALARM, appendJournal: appendJournal, appendSample: appendSample, putSnapshot: putSnapshot, pruneOld: pruneOld,
    JOURNAL_MAX: JOURNAL_MAX, SAMPLES_MAX: SAMPLES_MAX, MERGE_WINDOW_MS: MERGE_WINDOW_MS, DIAG_KEEP_MS: DIAG_KEEP_MS,
    hvDerive: hvDerive, hvState: hvState, hvSet: hvSet, hvInfo: hvInfo, hvEnforce: hvEnforce, HV_ENFORCE_DELAY_MS: HV_ENFORCE_DELAY_MS
  });
}
