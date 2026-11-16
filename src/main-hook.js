/*
 * B 站网页版 CDN 线路重排 —— MAIN world 注入脚本
 *
 * 实测结论（av170001）：
 *  - player.reload() / reloadAccess() 不会重打 /x/player/wbi/playurl，只重新初始化 MSE、
 *    重新「请求分段」。因此只改 playurl 无法对正在播的影片生效（除非整页重载）。
 *  - 正解：直接改写「分段请求(.m4s)」的 host。搭配 player.reload() 让播放器重发分段，
 *    这些分段就会被导到指定节点 —— 不整页刷新、保留全屏与进度。
 *  - host 差替后仍回 206 且 CORS 通过（已实测），故此法成立。akamai 例外：它的 URL 带绑档案的 token，
 *    只能用 B 站给的原始 URL（见 needsOwnSig）。
 *  - 2026-10 的回报日志：现在 player.reload() 之后约 1 秒内播放器会再打一次 playurl（同一支影片）。
 *
 * 设计：
 *  - 重排「关闭」(或选「原始」)时完全不碰原生行为：不 wrap fetch/XHR、不 defineProperty。
 *    debug 的「当前 CDN」用被动 PerformanceObserver 读取，不改变任何请求。
 *  - 换节点（仍启用）：player.reload() 在播放器内重载（保留全屏/进度），不整页刷新。
 *  - 开/关重排、切到/离开「原始」：需要安装/移除 hook，才整页重载。
 */
(function () {
  "use strict";
  if (window.__CDN_SWITCHER_INSTALLED__) return;
  window.__CDN_SWITCHER_INSTALLED__ = true;

  var CFG_KEY = "__CDN_SWITCHER_CFG__";
  var DEFAULTS = {
    enabled: true, // 预设开启
    cdnHost: "cn-bj-se-01-05.bilivideo.com", // 占位值：只在这个网域第一次载入、bridge 还没推设定过来的那一瞬间用（bridge 推的是使用者的节点或节点清单的全域预设；没有清单时 enabled=false）。'base' (= do not rewrite) is a legacy value: popup.js migrates it to videoEnabled=false, MAIN keeps accepting it for old configs
    autoFallback: true, // 速度不佳时自动优化节点（卡顿时先在清单里优化、还卡才切 B 站备援；直播切国际线路）：预设开启；网络本身不稳（弱 WiFi 等）的用户可关掉
    showDebug: false, // debug 叠层预设关闭，避免新装用户被打扰
    videoEnabled: true, // 一般影片的「关闭」：false = 不介入影片 CDN 选线（enabled 是总开关，管影片与直播）
    liveEnabled: true, // 直播的「关闭」：false = 不介入直播 CDN 选线
    liveRoute: "ov", // 直播线路偏好：ov / ovb / cn / cnb（记的是线路种类，不是具体 host，集群号随房间而变）
    autoSpeedHosts: [], // 自动测速要测的节点（popup 依目前国家写入）
    installTestPending: false, // 全新安装后第一支影片在背景优化一次（规则见 runAutoSpeedTest），触发即清
    stVideoMb: 8, // 测速门槛（与 popup 进阶设定共用）
    stVideoSec: 5
  };

  var cfg = readCfg();
  function readCfg() {
    var c = {};
    for (var k in DEFAULTS) c[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage.getItem(CFG_KEY);
      if (raw) { var p = JSON.parse(raw); for (var k2 in DEFAULTS) if (p[k2] !== undefined) c[k2] = p[k2]; }
    } catch (e) {}
    return c;
  }

  function isActive(c) { return !!c.enabled && c.videoEnabled !== false && c.cdnHost !== "base"; }
  // 终态提示按了「关闭介入」：这个分页（www.bilibili.com 的 sessionStorage）从此照 B 站原始行为，不改写 playurl、不救援；
  // 换影片、重新整理都还在，关掉分页才清，没有手动清除的方式。直播与嵌入式播放器在别的网域，读不到这个旗标
  var NOINT_KEY = "__CDN_SWITCHER_NO_INTERVENE__";
  var NO_INTERVENE = false;
  try { NO_INTERVENE = window.sessionStorage.getItem(NOINT_KEY) === "1"; } catch (e) {}
  var ACTIVE = isActive(cfg) && !NO_INTERVENE; // 依「载入当下」设定决定是否安装 hook（只管一般影片；直播的开关随时动态判断，见 liveActive）

  // MAIN world 没有 chrome.i18n（页面 context 无扩充 API），toast / debug 叠层的文案由
  // bridge.js（ISOLATED world）代查後经 localStorage/postMessage 送过来，读法与 cfg 相同。
  // DEFAULT_MSGS 是 bridge 尚未推送前的保底文案（繁中，与 _locales/zh_TW 一致）。
  var MSGS_KEY = "__CDN_SWITCHER_MSGS__";
  var DEFAULT_MSGS = {
    mhTermText: "所有節點都不流暢，你可以繼續觀看，或是關閉擴充介入回到B站預設",
    mhTermContinue: "繼續觀看",
    mhTermDisable: "關閉介入",
    mhCdnTargetOriginal: "原始（不覆寫）",
    mhCdnTargetBackup: "備用URL（優先）",
    mhToastLiveFallback: "目前直播線路不佳，已自動切換至國際線路(ov)",
    mhToastSwitched: "切換到 {host}",
    liveRouteOv: "國際線路(ov)",
    liveRouteOvB: "國際備用線路(ov-b)",
    liveRouteCn: "中國線路(cn)",
    liveRouteCnB: "中國備用線路(cn-b)"
  };
  var MSGS = readMsgs();
  function readMsgs() {
    var m = {};
    for (var k in DEFAULT_MSGS) m[k] = DEFAULT_MSGS[k];
    try {
      var raw = window.localStorage.getItem(MSGS_KEY);
      if (raw) { var p = JSON.parse(raw); for (var k2 in DEFAULT_MSGS) if (p[k2]) m[k2] = p[k2]; }
    } catch (e) {}
    return m;
  }

  // 自动回退的「静默覆写」：只影响本分页实际使用的节点，不写入用户设定 ——
  // popup 显示、下次手动重整仍以用户自选节点为准。备用URL 需整页重载才生效，
  // 重载前把覆写放进 sessionStorage 一次性带过去（读到就删，手动重整不会沿用）。
  var AUTO_KEY = "__CDN_SWITCHER_AUTO__";
  var autoHost = null; // null = 没有覆写；否则为具名备援 host 或 "backup"
  // 覆写是给哪支影片的：autoHostKey = 那支影片的 cid（套用当下还不知道就是 null，等第一次知道 cid 时绑上），
  // autoHostPath = 套用当下的网址路径（cid 不知道时，靠它分辨换了影片）
  var autoHostKey = null, autoHostPath = null;
  var carriedRescue = null; // 整页重新整理带过来的救援状态（见 rescueCarry）
  // 同一支影片的网址识别：路径加分 P（?p=）；fullReload 只会多加 t=
  function pageKeyOf(loc) { var p = ""; try { p = new URL(loc.href).searchParams.get("p") || ""; } catch (e) {} return loc.pathname + "?p=" + p; }
  try {
    var rawAuto = window.sessionStorage.getItem(AUTO_KEY);
    if (rawAuto) {
      window.sessionStorage.removeItem(AUTO_KEY);
      if (ACTIVE) {
        var pa = JSON.parse(rawAuto);
        if (pa && typeof pa.host === "string" && pa.host) { autoHost = pa.host; autoHostPath = location.pathname; }
        // 救援改用整页重新整理（播放器不能 reload）：同一支影片的「实际播放失败」与冷静期一起带过来，不然会在两个节点间来回重整
        if (pa && pa.page === pageKeyOf(location)) carriedRescue = { failed: Array.isArray(pa.failed) ? pa.failed.filter(function (h) { return typeof h === "string"; }) : [], cool: Number(pa.cool) || 0 };
      }
    }
  } catch (e) {}

  // 本页实际生效的目标：自动回退覆写优先，否则用户自选
  function effHost() { return autoHost || cfg.cdnHost; }
  // 具名节点模式（可做分段层即时差替）；'backup' 走 playurl 层、不做分段差替
  function isHostMode() { var h = effHost(); return h !== "base" && h !== "backup"; }

  var debug = {
    currentCdn: null, pickVideoHost: null, pickAudioHost: null,
    lastSource: null, rewriteCount: 0, segRewriteCount: 0, lastQn: null, lastError: null, lastErrorAt: 0,
    speedBps: 0, speedIdle: false, playInfoPinned: 0,
    playurlGiven: null, // playurl 原本給的第一個 video host（還沒被我們換掉的）：回報時跟「設定」「生效」三方比對
    lastSegMs: 0, // 最近一個分段的下載耗時（粗略延遲）
    hookAt: 0, playurlBeforeHook: false, // hook 裝好的時間點；裝好前頁面是否已經打過 playurl（競態）
    spaNav: 0
  };

  // ---------------- 問題回報用的事件日誌 / 採樣 ----------------
  // 送給 bridge（ISOLATED world）→ background 寫進 storage.session，只留 10 分鐘。這裡只負責「發生了什麼」，
  // 不存任何東西。疊層也留最近 3 筆給使用者看。分段 URL 只記 host 與檔名，簽名參數一律不帶。
  var recentEvents = [];
  function jlog(k, d) {
    if (window.top !== window) return; // iframe 裡的播放器（嵌入/預覽）不記，免得淹掉主頁的紀錄
    d = d || {};
    try { window.postMessage({ __cdnSwitcher: 1, dir: "journal", payload: { t: Date.now(), k: k, d: d } }, "*"); } catch (e) {}
    var parts = [];
    for (var key in d) if (d[key] != null && d[key] !== "") parts.push(key + "=" + (Array.isArray(d[key]) ? d[key].join("|") : d[key]));
    recentEvents.push({ t: Date.now(), s: k + " " + parts.join(" ") });
    if (recentEvents.length > 3) recentEvents.shift();
  }
  function shortHost(h) { return (h || "").replace(/\.bilivideo\.(com|cn)$/i, "").replace(/\.akamaized\.net$/i, "@akam"); }
  function segName(url) { try { var u = new URL(url, location.href); return u.hostname + u.pathname.replace(/^.*\//, "/"); } catch (e) { return ""; } }
  function pageTypeOf() {
    var p = location.pathname;
    if (location.hostname === "live.bilibili.com") return "live";
    if (/^\/bangumi\//.test(p)) return "bangumi";
    if (/^\/cheese\//.test(p)) return "cheese";
    if (/^\/video\//.test(p)) return "video";
    if (/^\/(list|medialist|festival|blackboard)\//.test(p)) return "list";
    return "other";
  }
  function pageInfo() {
    var p = location.pathname, m, info = { type: pageTypeOf(), path: p, top: window.top === window ? 1 : 0 };
    if ((m = /\/video\/(BV[0-9A-Za-z]+|av\d+)/.exec(p))) info.bvid = m[1];
    if ((m = /\/(?:bangumi|cheese)\/play\/(ep\d+|ss\d+)/.exec(p))) info.epid = m[1];
    if (info.type === "live" && (m = /^\/(\d+)/.exec(p))) info.room = m[1];
    try {
      var st = window.__INITIAL_STATE__;
      var cid = st && ((st.videoData && st.videoData.cid) || (st.epInfo && st.epInfo.cid));
      if (cid) info.cid = cid;
    } catch (e) {}
    try { var pv = window.player && typeof window.player.getVersion === "function" && window.player.getVersion(); if (pv) info.player = String(pv); } catch (e) {}
    return info;
  }
  function forwardBufferSec(v) {
    try {
      var bf = v.buffered, t = v.currentTime;
      for (var i = 0; i < bf.length; i++) if (t >= bf.start(i) - 0.1 && t <= bf.end(i)) return Math.max(0, bf.end(i) - t);
    } catch (e) {}
    return 0;
  }
  // DASH 会把所有画质塞在同一次 playurl 回应，之后使用者切画质是「同一份清单里换 representation」、
  // 不再打 playurl —— 所以不能只信 d.quality（那是预设画质，切了不会变）。
  // 改成：记下每个 video representation 的路径→画质代码，再看「实际正在下载的分段」是哪一档，得出当前画质。
  var videoQnByPath = {}; // pathname -> qn（每次解析 playurl 重建）
  var videoBwByPath = {}; // pathname -> 码率 bits/s（dash 的 bandwidth；救援时判断节点撑不撑得住目前画质）
  var lastVideoQn = null; // 最近实际下载过的 video 分段所属画质，比 d.quality 准

  var NATIVE_FETCH = window.fetch; // 存原生 fetch，供手动测速用，绕开下面装的 fetch hook

  // ---------------- helpers ----------------
  function asStr(v) { return typeof v === "string" ? v.trim() : ""; }
  function hostOf(url) { try { return new URL(url, location.href).host.toLowerCase(); } catch (e) { return ""; } }
  function pathOf(url) { try { return new URL(url, location.href).pathname; } catch (e) { return ""; } }
  function replaceHost(url, host) { try { var x = new URL(url, location.href); x.host = host; return x.toString(); } catch (e) { return url; } }
  function distinct(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) { var u = arr[i]; if (u && !seen[u]) { seen[u] = 1; out.push(u); } }
    return out;
  }

  // 主播放器的 video：页面上还有 hover 预览、迷你卡片等其他 video，不能一概用 querySelector
  function getMainVideo() {
    var p = getPlayerEl();
    return (p && p.querySelector("video")) || document.querySelector("video");
  }

  // ---------------- 画质代码 → 可读名称 ----------------
  var QN_LABELS = {
    6: "240P", 16: "360P", 32: "480P", 64: "720P", 74: "720P60",
    80: "1080P", 100: "1080P AI", 112: "1080P+", 116: "1080P60",
    120: "4K", 125: "HDR", 126: "Dolby Vision", 127: "8K"
  };
  // 当前实际画质：优先用「正在下载的分段」对应的画质（切画质会即时反映），
  // 还没下载过任何 video 分段时退回 playurl 的预设画质
  function currentQn() { return lastVideoQn != null ? lastVideoQn : debug.lastQn; }
  function qnText() {
    var q = currentQn();
    if (q == null) return "-";
    var name = QN_LABELS[q];
    return name ? name + " (" + q + ")" : String(q);
  }

  // ---------------- 分段下载速度（滚动视窗）----------------
  // 取样来源优先序：fetch/XHR 直接量测 > resource timing（跨网域需 Timing-Allow-Origin，
  // 拿不到 transferSize 时会是 0）。有直接量测就忽略 resource timing，避免同一段重复计入。
  var SPEED_WINDOW_MS = 10000;
  var speedSamples = []; // {at, bytes, ms}
  var lastDirectAt = 0;
  var lastSampleAt = 0; // 最近一次计入样本的时间：当作「线路仍有资料在动」的讯号（全黑备援、legacyCheckStall 用）
  var lastSegReqAt = 0; // 最近一次「送出分段请求」的时间：请求持续在送却抓不到资料 = 线路死了（全黑备援、legacyCheckStall 用）

  function addSample(bytes, ms, direct) {
    if (!(bytes > 0) || !(ms > 0)) return;
    var now = Date.now();
    if (direct) { lastDirectAt = now; debug.lastSegMs = ms; }
    else if (now - lastDirectAt < 30000) return;
    speedSamples.push({ at: now, bytes: bytes, ms: ms });
    lastSampleAt = now;
  }

  // 用「每段 bytes / 每段耗时」而非挂钟平均：播放器缓冲满就停抓，
  // 挂钟平均只会等于影片码率，量不到线路实际吞吐。
  function updateSpeed() {
    var cut = Date.now() - SPEED_WINDOW_MS, kept = [], b = 0, t = 0;
    for (var i = 0; i < speedSamples.length; i++) if (speedSamples[i].at >= cut) kept.push(speedSamples[i]);
    speedSamples = kept;
    for (var j = 0; j < kept.length; j++) { b += kept[j].bytes; t += kept[j].ms; }
    if (t > 0) { debug.speedBps = (b / t) * 1000; debug.speedIdle = false; }
    else debug.speedIdle = debug.speedBps > 0; // 视窗内没流量 → 保留上次数值并标记 idle
  }

  function speedText() {
    if (!debug.speedBps) return "-";
    var s = debug.speedBps >= 1048576
      ? (debug.speedBps / 1048576).toFixed(1) + " MB/s"
      : Math.round(debug.speedBps / 1024) + " kB/s";
    return debug.speedIdle ? s + " (idle)" : s;
  }

  var SEG_RE = /\/upgcxcode\/.*\.m4s|\/upgcxcode\//i;
  // Anchored on a label boundary so "attacker-bilivideo.com" does not count as a CDN host
  var CDN_HOST_RE = /(^|\.)(bilivideo\.(com|cn)|akamaized\.net|hdslb\.com)$/i;
  // 分段判定必须同时验 host：data.bilibili.com 的打点上报会把分段 URL 塞在 query 里，
  // 只看路径会把上报误认成分段（污染 currentCdn / 速度样本 / 备用URL模式的失败判定）
  function isSegUrl(url) { return SEG_RE.test(url) && CDN_HOST_RE.test(hostOf(url)); }

  // ---------------- 播放器上的提示 toast（挂在播放器容器内，全屏时也看得到）----------------
  var TOAST_SEL = [".bpx-player-container", "#bilibili-player", ".bpx-player-video-area", ".bpx-player-primary-area", "#live-player"];
  var toastEl = null, toastTimer = null, toastFadeTimer = null;

  function getToastHost() {
    // 优先挂外层容器：player.reload() 会重建内层 video 区域，挂太内层会连 toast 一起清掉
    for (var i = 0; i < TOAST_SEL.length; i++) { var el = document.querySelector(TOAST_SEL[i]); if (el) return el; }
    return document.body;
  }

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastFadeTimer) { clearTimeout(toastFadeTimer); toastFadeTimer = null; }
    if (toastEl && toastEl.parentElement) toastEl.parentElement.removeChild(toastEl);
    toastEl = null;
  }

  var TOAST_FONT = "-apple-system,'Microsoft JhengHei','Microsoft YaHei',sans-serif";
  // opts: { duration, actionText, onAction, cancelText, onCancel, persistent }
  //  - persistent=true：不设定时器，不会自动消失，只能靠 actionText/cancelText 按钮关掉
  //  - 有任一按钮时 toast 才接收滑鼠事件，否则不挡播放器操作
  function showToast(text, opts) {
    opts = opts || {};
    hideToast();
    var host = getToastHost();
    if (!host) return;
    var fixed = host === document.body;
    var hasButton = !!(opts.actionText || opts.cancelText);
    toastEl = document.createElement("div");
    toastEl.id = "cdn-switcher-toast";
    toastEl.style.cssText = [
      fixed ? "position:fixed" : "position:absolute",
      fixed ? "top:15%" : "top:24px",
      "left:50%", "transform:translateX(-50%)", "z-index:999999",
      // 放不下就讓按钮换到下一行：手机版页面（m.bilibili.com）播放器很窄，不换行时文字会被挤成一行一两个字、「关闭」被切掉
      "display:flex", "flex-wrap:wrap", "align-items:center", "gap:10px", "max-width:85%", "box-sizing:border-box",
      "font:13px/1.6 " + TOAST_FONT, "color:#fff",
      "background:rgba(0,0,0,.78)", "padding:8px 14px", "border-radius:8px",
      "box-shadow:0 2px 10px rgba(0,0,0,.35)", "opacity:1", "transition:opacity .4s",
      (hasButton ? "pointer-events:auto" : "pointer-events:none")
    ].join(";");
    var span = document.createElement("span");
    span.style.cssText = "flex:1 1 160px;min-width:0";
    span.textContent = text;
    toastEl.appendChild(span);
    if (opts.actionText && opts.onAction) {
      var btn = document.createElement("button");
      btn.textContent = opts.actionText;
      btn.style.cssText = "cursor:pointer;border:0;border-radius:6px;padding:5px 12px;font:13px " + TOAST_FONT + ";background:#00aeec;color:#fff;white-space:nowrap";
      btn.addEventListener("click", function () { var fn = opts.onAction; hideToast(); try { fn(); } catch (e) {} });
      toastEl.appendChild(btn);
    }
    if (opts.cancelText) {
      var cancelBtn = document.createElement("button");
      cancelBtn.textContent = opts.cancelText;
      cancelBtn.style.cssText = "cursor:pointer;border:1px solid rgba(255,255,255,.45);border-radius:6px;padding:5px 12px;font:13px " + TOAST_FONT + ";background:transparent;color:#fff;white-space:nowrap";
      cancelBtn.addEventListener("click", function () { var fn = opts.onCancel; hideToast(); if (fn) try { fn(); } catch (e) {} });
      toastEl.appendChild(cancelBtn);
    }
    try { if (!fixed && getComputedStyle(host).position === "static") host.style.position = "relative"; } catch (e) {}
    host.appendChild(toastEl);
    if (!opts.persistent) {
      var dur = opts.duration || 3000;
      toastFadeTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = "0"; }, Math.max(0, dur - 400));
      toastTimer = setTimeout(hideToast, dur);
    }
  }

  // ---------------- 自动救援（卡顿救援 v2，2026-11-16 定案）----------------
  // 两个入口，同时只跑一轮测速：
  //  入口一（卡顿）：看播放器画面元素（class）判断卡住，滚动 3 分钟内卡 3 次、或累计 5 秒就救援。目前的节点记失败（到换影片为止），
  //    依序测清单里的候选，换到够快的；都不够快、而且这次卡顿还没恢复，就显示终态提示（「继续观看」／「关闭介入」）。
  //    画面什么提示都没有的全黑（readyState 0、分段送出去却一直没资料）另外算，8 秒就救援。
  //  入口二（预测）：连续播放满 30 秒后，最近 20 秒有分段失败、或缓冲持续不到 3 秒，先测目前的节点，撑得住（≥ floor）就不换；
  //    撑不住才测候选：缓冲还够时把结果留作预备节点，缓冲掉到 3 秒以下才换。判定不救援就上锁。
  // 换节点只换这个分页（autoHost，不写设定、其他分页不受影响）；换节点后 30 秒冷静期；换影片（cid 变了）全部重来，失败标记也清掉。
  // 分页在背景／子母画面、关掉「速度不佳时自动优化节点」、popup 手动测速中、不是观看页：一律不侦测、不救援（rescueBlocked）。
  // 直播维持原样（maybeLiveFallback，走 legacyCheckStall 的直播路径），不套用这里的规则。
  // 安装后第一支影片的优化还没开始（installTestPending，而且有清单可测）时，影片先不做失败自动切换：
  // 不然卡顿时会先救援、优化完又换一次节点（播放器重载两次）。优化一开始旗标就清掉，之后照开关；直播不受影响
  function vodFallbackOn() { return !!cfg.autoFallback && !(cfg.installTestPending && (cfg.autoSpeedHosts || []).length); }
  var COOL_MS = 30000; // 换节点（救援、popup 手动、测速）后的冷静期：这段时间内不触发任何救援
  var PLAY_FAIL = Infinity; // 实际播放时失败的节点：记到换影片为止（防止测速都过关、实际一直卡时无限轮换）
  var TESTED_FAIL_TTL_MS = 60 * 1000; // 测速时不到 floor 或被放弃的节点
  var RESCUE_HEADROOM = 1.5; // floor = 目前画质码率 × 1.5
  var RESCUE_GOOD_X = 2; // good = max(floor, min(UHD_BPS, 2 × 码率))：第一个达到就停
  // 救援测速提早放弃：连 header 都要等超过这么久的节点不测了；测了这么久平均还不到 floor 一半的也不测了
  var RESCUE_TTFB_MS = 2500, RESCUE_SLOW_CHECK_MS = 1500;
  var E1_WINDOW_MS = 180000, E1_TRIGGER_N = 3, E1_TRIGGER_MS = 5000; // 入口一：滚动 3 分钟内 3 次，或累计 5 秒
  var E1_ESTABLISH_MS = 1000; // 卡住状态持续这么久才算一次卡顿（起算回溯到出现那一刻）
  var E1_RECOVER_MS = 2000; // 卡住状态消失后 currentTime 连续前进这么久才算恢复（结束时间回溯到开始前进那一刻）
  var USER_OP_GRACE_MS = 8000; // 使用者操作后这么久内出现的卡住不算（拖进度条、换画质本来就会缓冲）
  var BLACK_MS = 8000; // 全黑备援
  var E2_CONT_MS = 30000, E2_LOW_SEC = 3, E2_LOW_HOLD_MS = 1000, E2_FAIL_RECENT_MS = 20000, E2_GAP_MS = 60000;
  var STANDBY_TTL_MS = 60000, STANDBY_IDLE_MS = 20000; // 预备节点：选好起 60 秒，或 20 秒内都没有新的分段失败就作废
  var TICK_GAP_MS = 3000; // 取样中断超过这么久（电脑睡眠、分页被节流）：进行中的计时从恢复那一刻重新开始
  var UI_MISSING_MS = 10000, UI_MISSING_HOLD_MS = 3000; // 有 video 这么久了还找不到播放器元素（而且持续缺 3 秒）＝B 站改版，退回旧判断
  var TERM_MS = 10000; // 终态提示的倒数
  // coolUntil：冷静期结束的时间；failed：host → 失败标记到期的时间（PLAY_FAIL＝到换影片为止）；
  // noMore：这支影片选了「继续观看」，不再自动优化；exhausted：这支影片候选已用完（测的期间影片恢复了，没显示提示）；
  // manualPause：popup 按了手动测速，到测速页关掉为止
  var FALLBACK = { coolUntil: 0, failed: {}, noMore: false, exhausted: false, manualPause: false };
  var segFailAt = 0; // 最近一次「目前节点」的分段失败（入口二用；换节点、换影片清掉）
  // 最近一次目前节点的分段失败（不管有没有开自动切换）：mainVideoIdle 用
  var lastSegFailAt = 0, SEG_FAIL_STUCK_MS = 60000;
  var backupHosts = []; // 最近一次 playurl 解析到的候选 host（base + backupUrl），依出现顺序：只用来找 akamai 样本的 bilivideo 网址，不当救援候选
  var pendingBackupHosts = null; // rewriteRoot 期间收集用；有解析到才整批取代 backupHosts
  var pcdnSeen = {}; // 日誌：同一個 PCDN host 只記一次

  // 测试用开关（无任何 UI 入口，不影响一般用户）：在 DevTools console（页面 context）执行
  //   __cdnSwitcherSimulateStall()       → 接下来 60 秒把播放器当成「缓冲中」（不看画面元素），走真实救援流程
  //   __cdnSwitcherSimulateStall(90000)  → 自订模拟时长（毫秒）；传 0 取消
  //   __cdnSwitcherSimulateStall("ask")  → 不等计时，立刻弹出终态提示（按钮为真实行为，「关闭介入」会真的整页重新整理、不再介入）
  var simulateStallUntil = 0;
  window.__cdnSwitcherSimulateStall = function (arg) {
    if (arg === "ask") { showTerminal("simulated"); return "terminal prompt shown"; }
    simulateStallUntil = Date.now() + (typeof arg === "number" ? arg : 60000);
    return simulateStallUntil > Date.now()
      ? "simulating stall for " + Math.round((simulateStallUntil - Date.now()) / 1000) + "s"
      : "canceled";
  };

  function isFailureStatus(status) {
    return status === 403 || status === 404 || status === 451 || (status >= 500 && status < 600);
  }

  // 分段 URL 的 deadline（unix 秒）已过：整份 playurl 签名失效，换 host 也一样 403，
  // 该交给播放器自己重打 playurl，不算目前 CDN 坏掉
  function isExpiredUrl(url) {
    try {
      var dl = new URL(url, location.href).searchParams.get("deadline");
      return !!dl && parseInt(dl, 10) * 1000 < Date.now();
    } catch (e) { return false; }
  }

  // 具名节点模式下只认目前节点的分段；备用URL模式没有做 host 差替，任何分段失败都算数
  function isCurrentSegHost(host) { return isHostMode() ? host === effHost() : !!host; }

  function shouldFallbackOnStatus(status, url) {
    if (!isFailureStatus(status)) return false;
    if (status === 403 && isExpiredUrl(url)) return false;
    return isCurrentSegHost(hostOf(url));
  }

  var mediaKey = null; // 现在这支影片的 cid
  // 影片识别用 cid（/upgcxcode/xx/yy/<cid>/…）：同一支影片的 playurl 第一个 base 有时是 PCDN（/v1/resource/…），取不到 cid 就不当成换了影片
  function cidOf(url) { var m = /\/upgcxcode\/\d+\/\d+\/(\d+)\//.exec(pathOf(url) || ""); return m ? m[1] : null; }
  // 改写之前先看这份 playurl 是哪支影片（换影片要先取消救援的覆写，再照使用者的节点改写）
  function peekMediaKey(d) {
    if (!d || typeof d !== "object") return null;
    var tracks = (d.dash && Array.isArray(d.dash.video) ? d.dash.video : []).concat(Array.isArray(d.durl) ? d.durl : []);
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t || typeof t !== "object") continue;
      var bk = t.backupUrl || t.backup_url || [];
      var urls = [asStr(t.baseUrl) || asStr(t.base_url) || asStr(t.url)].concat(Array.isArray(bk) ? bk.map(asStr) : []);
      for (var j = 0; j < urls.length; j++) { var c = urls[j] && cidOf(urls[j]); if (c) return c; }
    }
    return null;
  }
  // 播放器现在在播哪支影片（cid）。「最后一份 playurl」不等于「正在播的影片」：自动连播换到下一支后，
  // 播放器紧接着会再打别支影片的 playurl（Safari 实测 2026-11：先打下一支、隔一秒又打第三支），
  // 拿 playurl 判断换影片的话，之后在这支影片救援，player.reload() 重打的 playurl 会被当成「换了影片」，
  // 覆写当场被取消、回到卡住的节点。读不到（播放器没有 getManifest、播放器重载中）回传 null，维持上一个值
  function playerVideoKey() {
    try {
      var p = window.player, m = p && typeof p.getManifest === "function" ? p.getManifest() : null;
      var c = m && m.cid;
      return (typeof c === "number" || typeof c === "string") && /^[1-9]\d*$/.test(String(c)) ? String(c) : null;
    } catch (e) { return null; }
  }
  // 换到另一支影片＝全部重来（等于在新分页开始播）：卡顿纪录、失败标记、冷静期、预备节点、上锁、「不再优化」「候选已用完」、
  // 进行中的救援测速与终态提示都清掉。救援的覆写只管前一支，取消 —— 在 playurl 改写之前呼叫，这份 playurl 才会照使用者的节点改写。
  // 整页重载带过来的覆写（不是这页的第一支影片）要留着
  function noteVideoKey(key, by) {
    if (key == null || key === mediaKey) return;
    jlog("page.video", { cid: key, from: mediaKey || "", by: by || "" });
    var first = mediaKey == null;
    mediaKey = key;
    resetForVideo(first);
    if (!autoHost) return;
    // 覆写绑在影片上：知道是哪支就比 cid；套用时还不知道（整页重载带过来的、或当时读不到 cid）就看网址路径有没有换，
    // 没换就当成同一支、绑上这个 cid
    var stale = autoHostKey != null ? autoHostKey !== key : (autoHostPath != null && autoHostPath !== location.pathname);
    if (!stale) { if (autoHostKey == null) autoHostKey = key; return; }
    jlog("fb.autoClear", { reason: "next-video", host: autoHost === "backup" ? "backup" : shortHost(autoHost) });
    autoHost = null; autoHostKey = null; autoHostPath = null; renderOverlay(); postDebug();
  }
  function resetForVideo(first) {
    // 这页第一次知道 cid：不是换影片（可能已经卡住、正在救援），什么都不清；整页重新整理带过来的救援状态在这时补上
    if (first) {
      if (carriedRescue) {
        carriedRescue.failed.forEach(function (h) { markFailed(h, PLAY_FAIL); });
        FALLBACK.coolUntil = Math.max(FALLBACK.coolUntil, carriedRescue.cool);
        carriedRescue = null;
      }
      return;
    }
    abortRescue("next-video");
    closeTerminal("next-video");
    FALLBACK.failed = {}; FALLBACK.noMore = false; FALLBACK.exhausted = false; FALLBACK.coolUntil = 0;
    e1NoSampleLogged = false;
    segFailAt = 0;
    e1.eps = []; e1.ep = null; blackReset();
    e2Reset(true);
    // 卡住 class 可能從前一支一路掛到新影片（自动连播时载入画面先出现、新 cid 才进来）：
    // 清掉「已在卡」的记忆，下一次取样就会替新影片重新开始算，不然 class 一直在就永远不会再建立卡顿
    UI.stuck = ""; UI.since = 0;
    UI.missing = false; UI.missingSince = 0; UI.videoSince = 0;
    legacyReset();
  }

  // 换了节点（救援、popup 手动、测速）：前一个节点的卡顿纪录、分段失败不算到新节点头上，入口二解锁、预备节点作废，
  // 并给新节点 30 秒冷静期（grace 为 false 时不给：页面刚载入、还没抓过分段时 bridge 推设定过来，不是「换掉正在用的节点」）
  function onNodeSwitched(grace) {
    var now = Date.now();
    legacyReset();
    e1.eps = [];
    if (e1.ep) { e1.ep.start = Math.max(e1.ep.start, now); e1.ep.estAt = 0; }
    blackReset();
    segFailAt = 0;
    e2Reset(false);
    if (grace !== false) FALLBACK.coolUntil = Math.max(FALLBACK.coolUntil, now + COOL_MS);
  }
  // 使用者自己换节点（popup 选节点、手动测速后套用、点自己的节点换回）：中止救援、丢弃结果，恢复这支影片的自动优化，关掉终态提示；失败标记保留
  function onUserSwitched(by) {
    abortRescue(by);
    closeTerminal(by);
    FALLBACK.noMore = false; FALLBACK.exhausted = false;
  }

  // FALLBACK.failed[host] = 失败标记到期的时间
  function isFailed(h, now) { var until = FALLBACK.failed[h]; return !!until && (now || Date.now()) < until; }
  function markFailed(h, ttl) {
    if (!h || h === "backup") return;
    var until = ttl === PLAY_FAIL ? PLAY_FAIL : Date.now() + (ttl || TESTED_FAIL_TTL_MS);
    FALLBACK.failed[h] = Math.max(FALLBACK.failed[h] || 0, until);
  }
  function failedHosts() { var now = Date.now(); return Object.keys(FALLBACK.failed).filter(function (h) { return isFailed(h, now); }); }

  // 救援候选＝清单（国家清单、自订清单；选「全部」时 popup 写的是 OTHER 清单），扣掉目前的与还没过期的失败标记。
  // 不另外加 B 站 playurl 给的节点：清单是使用者用测速报告维护的，够快的本来就会在清单里
  function listCands() {
    var now = Date.now(), cur = effHost(), out = [];
    (cfg.autoSpeedHosts || []).forEach(function (h) {
      if (!h || h === "backup" || h === cur || out.indexOf(h) >= 0 || isFailed(h, now)) return;
      out.push(h);
    });
    return out;
  }

  // 记下 playurl 给的候选 host：滤掉 PCDN（mcdn，品质不稳）；带端口的 host 过不了
  // CDN_HOST_RE 的 $ 锚定，顺带被排除（分段差替也不适用带端口的节点）
  function noteBackupHost(url) {
    if (pendingBackupHosts == null || !url) return;
    var h = hostOf(url);
    if (h && h.indexOf(".mcdn.") >= 0 && !pcdnSeen[h]) { pcdnSeen[h] = 1; jlog("cdn.pcdn", { host: h }); }
    if (!h || !CDN_HOST_RE.test(h) || h.indexOf(".mcdn.") >= 0) return;
    if (pendingBackupHosts.indexOf(h) < 0) pendingBackupHosts.push(h);
  }

  // 静默套用自动回退：只动 autoHost，不碰 cfg 与 chrome.storage（用户设定不变）。next 为 null = 取消覆写、回到用户设定的节点
  function applyAutoHost(next) {
    autoHost = next || null;
    autoHostKey = next ? mediaKey : null; autoHostPath = next ? location.pathname : null;
    onNodeSwitched(); // 换了节点，前一个节点的失败不算到新节点头上
    renderOverlay(); postDebug();
    if (next === "backup") {
      // 备用URL 走 playurl 层，需重打 playurl 才生效 → 整页重载，覆写用 sessionStorage 一次性带过去
      try { window.sessionStorage.setItem(AUTO_KEY, JSON.stringify(rescueCarry(next))); } catch (e) {}
      fullReload();
    } else if (!playerReload()) {
      // 具名备援本走播放器内重载；player.reload 不可用时退整页重载，同样一次性带覆写
      if (next) { try { window.sessionStorage.setItem(AUTO_KEY, JSON.stringify(rescueCarry(next))); } catch (e) {} }
      fullReload();
    }
  }

  // 整页重新整理要带过去的：覆写的节点，加上同一支影片（同网址路径）实际播放失败的节点与冷静期到期时间
  function rescueCarry(next) {
    var failed = Object.keys(FALLBACK.failed).filter(function (h) { return FALLBACK.failed[h] === PLAY_FAIL; });
    return { host: next, page: pageKeyOf(location), failed: failed, cool: FALLBACK.coolUntil };
  }
  // 取消这个分页的救援覆写、回到使用者设定的节点（popup 点了使用者自己的节点）。备用URL 走 playurl 层，离开要整页重载；具名节点播放器内重载即可
  function clearAutoHost(by) {
    if (!autoHost) return;
    jlog("fb.autoClear", { reason: by, host: autoHost === "backup" ? "backup" : shortHost(autoHost) });
    onUserSwitched(by);
    if (autoHost === "backup") { autoHost = null; onNodeSwitched(); fullReload(); return; }
    applyAutoHost(null);
  }

  // 救援在背景默默进行，没有任何提示（使用者 2026-11-16）：看得到的只有 popup 的「这个分页暂时改用了 xxx」与终态提示。
  // 救援选出的节点：只在这个分页覆写（autoHost），不写进设定 —— 设定是使用者自己的选择，救援是不得已才发生的；
  // 其他分页、之后开的分页照样用设定里的节点，不会被重载（回报 #46 #47：一个分页换节点，正在看的分页跟着重载）。
  // 选到的正是用户设定的节点（目前在用覆写）就取消覆写
  function applyRescuePick(pick, reason) {
    var from = effHost();
    debug.lastError = "auto-fallback(" + reason + "): " + from + " -> " + pick;
    var fv = getMainVideo();
    jlog("fb.switch", { reason: reason, from: shortHost(from), to: shortHost(pick), buf: fv ? forwardBufferSec(fv).toFixed(1) : "-" });
    applyAutoHost(pick === cfg.cdnHost ? null : pick); // onNodeSwitched 给 30 秒冷静期
  }

  // 目前画质「实际要的」速度（bytes/s）：playurl 的 dash 码率 × 播放速度（2 倍速要两倍的量）；没有码率回传 0
  function currentBitrateBps() {
    var bw = videoBwByPath[pathOf(sampleUrl() || "")];
    if (!(typeof bw === "number" && bw > 0)) return 0;
    var v = getMainVideo(), rate = v && v.playbackRate > 1 ? v.playbackRate : 1;
    return bw / 8 * rate;
  }

  // 分页不在前景（切到别的分页、视窗最小化）：使用者没在看，一律不做自动切换、不跑自动测速，计时也不累计。
  // 回报 #46 #47：在背景开了好几支影片，背景分页的 video 一直是 readyState 0（Chrome 背景分页不载入媒体），
  // 第一个分段又因为一起抢频宽慢了几秒，被当成「线路死了」连换好几次节点，还把使用者正在看的分页一起重载。
  // 子母画面（影片弹成小窗、主视窗切到别的分页）也算背景，是刻意的决定：主视窗可能正在播另一支 B 站影片，
  // 两支同时在播时无法确定使用者在看哪一支，所以一律不救（Chrome 实测此时 visibilityState 是 hidden）
  function tabHidden() { try { return document.visibilityState === "hidden" || inPip(); } catch (e) { return false; } }
  // 子母画面一律算背景（使用者决定：主视窗可能同时在播另一支影片，无法确定在看哪一支）。分页还在前景、只把影片弹出去时，
  // visibilityState 仍是 visible，要另外看：标准 PiP、Safari 的 webkitPresentationMode、Document PiP
  function inPip() {
    try {
      if (document.pictureInPictureElement) return true;
      if (window.documentPictureInPicture && window.documentPictureInPicture.window) return true;
      var vs = document.getElementsByTagName("video");
      for (var i = 0; i < vs.length; i++) if (vs[i].webkitPresentationMode === "picture-in-picture") return true;
    } catch (e) {}
    return false;
  }

  // 这个 video 播放过没有（played 有区间）：没播过的暂停 = 还没开始，不是卡住
  function hasPlayed(v) { try { return !!(v.played && v.played.length); } catch (e) { return false; } }

  // currentTime 前方是否还有已缓冲的资料：有＝随时能继续播（暂停是使用者主动的）；
  // 没有＝缓冲耗尽（播放器可能已自己停下）
  function hasForwardBuffer(v) {
    try {
      var bf = v.buffered;
      for (var i = 0; i < bf.length; i++) {
        if (v.currentTime >= bf.start(i) - 0.1 && v.currentTime < bf.end(i) - 0.5) return true;
      }
    } catch (e) {}
    return false;
  }
  // 前方缓冲（实际秒数）：包含 currentTime 的那一段的结束点减 currentTime，再除以播放速度；不在任何一段里＝0
  function bufSec(v) { return v ? forwardBufferSec(v) / (v.playbackRate > 0 ? v.playbackRate : 1) : 0; }
  // 接近片尾：剩余片长 ÷ 播放速度 ≤ 3 秒，或包含 currentTime 的那一段已下载到片尾前 0.5 秒以后
  function nearEndE2(v) {
    var d = v.duration;
    if (!d || !isFinite(d)) return false;
    var rate = v.playbackRate > 0 ? v.playbackRate : 1;
    if ((d - v.currentTime) / rate <= 3) return true;
    return v.currentTime + forwardBufferSec(v) >= d - 0.5;
  }

  // ---------------- 系统判断「不偵測、不救援」（入口一、入口二共用）----------------
  // 回传原因（空字串＝可以侦测）。条件解除时，正卡着的那次从那一刻重新算、入口二重新等连续播放 30 秒（见 holdTimers）
  function rescueBlocked(now) {
    if (!ACTIVE) return "inactive";
    if (!vodFallbackOn()) return "off";
    if (tabHidden()) return "hidden";
    if (!WATCH_RE.test(location.pathname)) return "page";
    if (FALLBACK.manualPause || speedTestRunning) return "manual-test";
    if (FALLBACK.noMore) return "no-more";
    if (term) return "prompt";
    // 使用者主动操作后冷却 8 秒（使用者 2026-11-16）：拖进度条、换画质、暂停等造成的卡顿或缓冲过低都不算，8 秒后从那一刻重新开始监听
    if (userCoolUntil(now) > (now || Date.now())) return "user-op";
    if ((now || Date.now()) < FALLBACK.coolUntil) return "cool";
    return "";
  }

  // ---------------- 画面元素：播放器显示「卡住」（只用 class，不看文字；B 站各语系 class 相同）----------------
  // 缓冲中：容器带 bpx-state-buff；错误画面：容器带 bpx-player-error-sign-active 且错误码 3001；载入画面：loading-panel 带 bpx-state-loading。
  // 这些元素平常就在 DOM 里，要看状态 class。MutationObserver 记下出现的时刻（每秒的检查当保险，B 站会重建播放器 DOM）
  var UI = { stuck: "", since: 0, goneAt: 0, errLogged: "", missing: false, missingSince: 0, videoSince: 0, obsC: null, obsL: null, mo: null };
  function uiContainer() {
    var v = getMainVideo(), c = v && v.closest ? v.closest(".bpx-player-container") : null;
    return c || document.querySelector(".bpx-player-container");
  }
  function uiFind(c, sel) { return (c && c.querySelector(sel)) || document.querySelector(sel); }
  function uiErrCode(c) { var el = uiFind(c, ".bpx-player-error-sign-code"), m = el && /\d+/.exec(el.textContent || ""); return m ? m[0] : ""; }
  function uiStuckKind() {
    if (Date.now() < simulateStallUntil) return "sim";
    var c = uiContainer();
    if (!c) return "";
    if (c.classList.contains("bpx-state-buff")) return "buff";
    var lp = uiFind(c, ".bpx-player-loading-panel");
    if (lp && lp.classList.contains("bpx-state-loading")) return "load";
    if (c.classList.contains("bpx-player-error-sign-active")) {
      var code = uiErrCode(c);
      if (code === "3001") return "err";
      // 别的错误（或读不到错误码）可能是下架、权限、地区，换节点救不了：只记日志
      if (UI.errLogged !== (code || "?")) { UI.errLogged = code || "?"; jlog("ui.errsign", { code: code || "?" }); }
    } else UI.errLogged = "";
    return "";
  }
  function uiSample(now) {
    var k = uiStuckKind();
    if (k && !UI.stuck) { UI.since = now; UI.stuck = k; onStuckAppear(now, k); return; }
    if (!k && UI.stuck) UI.goneAt = now;
    UI.stuck = k;
  }
  function uiObserve() {
    if (typeof MutationObserver !== "function") return;
    var c = uiContainer(), lp = c ? uiFind(c, ".bpx-player-loading-panel") : null;
    if (c === UI.obsC && lp === UI.obsL) return;
    if (UI.mo) { try { UI.mo.disconnect(); } catch (e) {} UI.mo = null; }
    UI.obsC = c; UI.obsL = lp;
    if (!c) return;
    try {
      UI.mo = new MutationObserver(function () { if (ACTIVE && !IS_LIVE_PAGE && !UI.missing) uiSample(Date.now()); });
      UI.mo.observe(c, { attributes: true, attributeFilter: ["class"] });
      if (lp) UI.mo.observe(lp, { attributes: true, attributeFilter: ["class"] });
    } catch (e) {}
  }
  // 画面元素失效（B 站改版）：观看页有 video 已经 10 秒以上，却找不到容器或三个状态元素任一个 → 到换影片为止改用旧的影片元素判断。
  // 要持续缺 3 秒才算（B 站重建播放器 DOM 的那一瞬间也会缺）
  function uiMissingCheck(now, v) {
    if (UI.missing) return;
    if (!v) { UI.videoSince = 0; UI.missingSince = 0; return; }
    if (!UI.videoSince) UI.videoSince = now;
    if (now - UI.videoSince < UI_MISSING_MS) return;
    var c = uiContainer();
    var miss = !c ? "container" : !uiFind(c, ".bpx-player-state-wrap") ? "state-wrap" : !uiFind(c, ".bpx-player-loading-panel") ? "loading-panel" : !uiFind(c, ".bpx-player-error-sign") ? "error-sign" : "";
    if (!miss) { UI.missingSince = 0; return; }
    if (!UI.missingSince) { UI.missingSince = now; return; }
    if (now - UI.missingSince < UI_MISSING_HOLD_MS) return;
    UI.missing = true; UI.stuck = "";
    jlog("ui.missing", { el: miss });
    legacyReset(); blackReset();
    if (e1.ep) endEp(now, "ui-missing");
  }

  // ---------------- 使用者操作：之后 8 秒内出现的卡住不算 ----------------
  // 在 document 的 capture 阶段听，用 closest 判断点到哪个控制元件（B 站会重建 DOM，不能直接挂在元素上）
  var userOps = []; // 最近几次使用者操作的时间
  var OP_SEL = ".bpx-player-ctrl-play,.bpx-player-video-wrap,.bpx-player-progress-wrap,.bpx-player-shadow-progress-area," +
    ".bpx-player-ctrl-quality,.bpx-player-ctrl-playbackrate,.bpx-player-ctrl-eplist,.bpx-player-ctrl-prev,.bpx-player-ctrl-next";
  var opLogged = {}; // 日志：同一种操作 2 秒内只记一笔（按住方向键、拖进度条不要洗掉问题回报的日志）
  function noteUserOp(kind, at) {
    at = at || Date.now();
    userOps.push(at);
    if (userOps.length > 8) userOps.shift();
    if (kind && !(opLogged[kind] && at - opLogged[kind] < 2000)) { opLogged[kind] = at; jlog("ui.op", { k: kind }); }
  }
  // t 这个时刻（含）以前最后一次使用者操作；卡住开始之后的操作不延长排除期
  function lastOpBefore(t) { for (var i = userOps.length - 1; i >= 0; i--) if (userOps[i] <= t) return userOps[i]; return 0; }
  function userCoolUntil() { var op = userOps.length ? userOps[userOps.length - 1] : 0; return op ? op + USER_OP_GRACE_MS : 0; }
  function excludeStart(t) { var op = lastOpBefore(t); return op && t - op < USER_OP_GRACE_MS ? op + USER_OP_GRACE_MS : t; }
  function isTypingTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || !!t.isContentEditable;
  }
  try {
    var onOpPointer = function (e) {
      var t = e && e.target;
      try { if (t && t.closest && t.closest(OP_SEL)) noteUserOp(e.type === "click" ? "" : "ptr"); } catch (err) {}
    };
    document.addEventListener("pointerdown", onOpPointer, true);
    document.addEventListener("click", onOpPointer, true);
    document.addEventListener("keydown", function (e) {
      if (!e) return;
      // 在留言框、弹幕框打字：B 站留言区在 shadow DOM 里，到 document 时 target 已经换成 shadow host，要看 composedPath 的第一个
      var t = e.target;
      try { var cp = typeof e.composedPath === "function" ? e.composedPath() : null; if (cp && cp.length) t = cp[0]; } catch (err) {}
      if (isTypingTarget(t)) return;
      if (e.repeat) { if (e.key === "ArrowLeft" || e.key === "ArrowRight") noteUserOp(""); return; } // 按住方向键：照样算操作，但不记日志
      var k = e.key;
      if (k === " " || k === "Spacebar" || k === "ArrowLeft" || k === "ArrowRight") noteUserOp("key");
    }, true);
  } catch (e) {}
  // 系统媒体键、耳机：mediaSession 没有事件可听，包装 setActionHandler（main-hook 在 document_start 执行，早于 B 站注册）
  try {
    var ms = navigator.mediaSession;
    if (ms && typeof ms.setActionHandler === "function") {
      var origSet = ms.setActionHandler;
      ms.setActionHandler = function (action, handler) {
        var h = typeof handler === "function" ? function () { noteUserOp("media"); return handler.apply(this, arguments); } : handler;
        return origSet.call(this, action, h);
      };
    }
  } catch (e) {}

  // ---------------- 入口一：卡顿 ----------------
  // ep：进行中的一次卡顿 { start（开始时间，回溯到卡住状态出现；排除期内出现的是第 8 秒那一刻）, estAt（成立的时间，0＝还没成立）,
  //   moveFrom（卡住状态消失后 currentTime 开始连续前进的时刻）}；eps：已结束、成立过的卡顿 { start, end, estAt }
  var e1 = { eps: [], ep: null };
  function onStuckAppear(now, kind) {
    if (e1.ep) { e1.ep.moveFrom = null; return; } // 空档（class 闪烁、播放器小跳）：还是同一次
    if (UI.missing) return;
    var start = excludeStart(now);
    e1.ep = { start: start, estAt: 0, moveFrom: null, lastCt: null, lastAt: now, kind: kind, excl: start > now };
    var v = getMainVideo();
    jlog("fb.stall", { phase: "start", kind: kind, excl: start > now ? Math.round((start - now) / 1000) : "", rs: v ? v.readyState : -1, paused: v ? v.paused : "", buf: v ? forwardBufferSec(v).toFixed(1) : "" });
  }
  function endEp(at, why) {
    var ep = e1.ep;
    e1.ep = null;
    if (!ep) return;
    if (ep.estAt) e1.eps.push({ start: ep.start, end: Math.max(at, ep.start), estAt: ep.estAt });
    jlog("fb.stall", { phase: "clear", by: why, counted: ep.estAt ? 1 : 0, sec: ep.estAt ? Math.round((Math.max(at, ep.start) - ep.start) / 100) / 10 : "" });
  }
  // 每秒：这次卡顿结束了没有、成立了没有。「成立」要当下卡住 class 还在（一闪而过、在空档里过了 1 秒的不算），
  // 而且这一秒不是「不侦测」（冷静期、测速、背景期间结束的卡顿不算次数）
  function e1Track(now, v, blocked) {
    var ep = e1.ep;
    if (!ep) return;
    var ct = v ? v.currentTime : null;
    if (UI.stuck) ep.moveFrom = null;
    else if (!v || v.ended || v.paused) {
      // 卡住状态消失时影片是暂停（不论谁按的）或播完：这次卡顿在卡住状态消失的那一刻结束（不然卡住时按暂停会一直累计到误触发）
      endEp(Math.min(UI.goneAt || now, now), !v ? "no-video" : v.ended ? "ended" : "paused");
      return;
    } else {
      if (ep.lastCt != null && ct > ep.lastCt) {
        if (ep.moveFrom == null) ep.moveFrom = Math.max(ep.lastAt, now - (ct - ep.lastCt) * 1000 / (v.playbackRate > 0 ? v.playbackRate : 1));
      } else ep.moveFrom = null;
      if (ep.moveFrom != null && now - ep.moveFrom >= E1_RECOVER_MS) { endEp(ep.moveFrom, "resumed"); return; }
    }
    ep.lastCt = ct; ep.lastAt = now;
    if (!ep.estAt && !blocked && UI.stuck && now - ep.start >= E1_ESTABLISH_MS) ep.estAt = ep.start + E1_ESTABLISH_MS;
  }
  // 滚动 3 分钟内：成立的次数（看成立时间）与卡顿秒数（只算窗内，含进行中的那次）
  function e1Stats(now) {
    var lo = now - E1_WINDOW_MS, n = 0, ms = 0;
    e1.eps = e1.eps.filter(function (e) { return e.end > lo || e.estAt > lo; });
    e1.eps.forEach(function (e) { if (e.estAt > lo) n++; ms += Math.max(0, e.end - Math.max(e.start, lo)); });
    var ep = e1.ep;
    if (ep && ep.estAt) { if (ep.estAt > lo) n++; ms += Math.max(0, now - Math.max(ep.start, lo)); }
    return { n: n, ms: ms };
  }
  // 触发救援后（不论结果）次数与时间归零；还卡着的那次从现在重新算（测速中会一直往后推，见 holdTimers）
  function e1Reset(now) {
    e1.eps = [];
    if (e1.ep) { e1.ep.start = Math.max(e1.ep.start, now); e1.ep.estAt = 0; }
    if (BLACK.base) BLACK.base = Math.max(BLACK.base, now);
  }

  // ---- 全黑备援：什么提示都没有，readyState 0，分段请求送出去却一直拿不到资料（番剧页只有 CDN 坏时，播放器重载后停在这里）----
  // 计时起点＝最晚的：readyState 变成 0、这段等待中第一个分段请求、全黑开始前最后一次使用者操作后 8 秒。从起点满 8 秒就算入口一达标
  var BLACK = { rs0At: 0, reqAt: 0, base: 0 };
  var rs0EventAt = 0; // 主 video 最近一次 emptied／loadstart（readyState 变回 0）的时间
  function blackReset() { BLACK.rs0At = 0; BLACK.reqAt = 0; BLACK.base = 0; }
  function noteSegReq(t) { lastSegReqAt = t; if (BLACK.rs0At && !BLACK.reqAt && t >= BLACK.rs0At) BLACK.reqAt = t; }
  function blackTrack(now, v) {
    if (UI.stuck || !v || v.readyState !== 0) { blackReset(); return; }
    if (!BLACK.rs0At) BLACK.rs0At = rs0EventAt && rs0EventAt <= now && v === trackedVideo ? rs0EventAt : now;
    if (!BLACK.reqAt) { if (lastSegReqAt >= BLACK.rs0At) BLACK.reqAt = lastSegReqAt; else return; }
    var ws = Math.max(BLACK.rs0At, BLACK.reqAt);
    if (lastSampleAt >= ws) { blackReset(); return; } // 有资料进来了
    if (!BLACK.base) {
      var op = lastOpBefore(ws);
      BLACK.base = Math.max(ws, op ? op + USER_OP_GRACE_MS : 0);
      jlog("fb.black", { phase: "start", wait: Math.round((BLACK.base - now) / 1000) });
    }
  }

  // ---- 入口一达标：救援 ----
  var e1NoSampleLogged = false;
  function stallOngoing() { return !!e1.ep || !!BLACK.base || (UI.missing && (stallState.stuckSince != null || !!stallState.ongoing)); }
  function rescue1(reason, info) {
    var now = Date.now();
    e1Reset(now);
    var wasOngoing = !!stallState.ongoing;
    legacyReset();
    stallState.ongoing = wasOngoing;
    jlog("fb.hit", { entry: 1, reason: reason, n: info ? info.n : "", sec: info ? Math.round(info.ms / 100) / 10 : "" });
    if (FALLBACK.exhausted) { showTerminal(reason); return true; } // 这支影片候选已用完：直接显示终态，不再测
    var cur = effHost();
    if (R && R.aborted) return false; // 已中止、正在收尾的一轮：等它结束，不升级、不另开
    if (R && R.src === 2) {
      // 入口二那轮还在跑：不另开一轮，改成入口一触发，目前节点记失败；还在测目前节点就丢掉那个结果
      markFailed(cur, PLAY_FAIL);
      R.src = 1; R.reason = reason;
      jlog("fb.upgrade", { from: R.kind, cur: R.measuring === R.from ? 1 : 0 });
      if (R.measuring === R.from && speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
      return true;
    }
    if (R || autoTestRunning) return false; // 别的测速（安装后那次）还在跑：等它
    var sb = standbyOk(now) ? e2.standby : null;
    if (sb) { markFailed(cur, PLAY_FAIL); e2.standby = null; applyRescuePick(sb.host, reason + "-standby"); return true; }
    var cands = listCands();
    if (!cands.length) { markFailed(cur, PLAY_FAIL); jlog("fb.noCand", { entry: 1 }); terminalOrExhaust(reason); return true; }
    // 一个都测不了（没有样本、候选都没有可测的网址）：当成这一轮逾时没测完 —— 不换、不记失败、不进终态，下次触发再试
    if (!startRound(1, reason, "rescue", "", cands)) {
      if (!e1NoSampleLogged) { e1NoSampleLogged = true; jlog("fb.noSample", { entry: 1 }); } // 每支影片只记一次，不然每 5 秒一笔会洗掉日志
      return false;
    }
    markFailed(cur, PLAY_FAIL);
    return true;
  }
  // 候选用完（或整轮测完都没有 ≥ floor）：这次卡顿还没恢复就显示终态提示；测的期间已经恢复，就记住「候选已用完」、不打扰
  function terminalOrExhaust(reason) {
    if (stallOngoing()) { showTerminal(reason); return; }
    FALLBACK.exhausted = true;
    jlog("fb.exhausted", { reason: reason });
  }

  // ---------------- 入口二：预测 ----------------
  // contSince：连续播放的起点（暂停、waiting、跳转、卡住、换节点、换影片都归零）；lowSince：缓冲开始不到 3 秒的时刻；
  // locked：判定不救援后上锁（换节点、换影片，或中断过再重新连续播放满 30 秒才解锁）；
  // last：这个节点上一轮的结果 { end, trig, host, kept }；standby：预备节点 { host, at }；voidAt：预备节点作废的时间
  var e2 = { contSince: null, lastCt: -1, lastAt: 0, lowSince: null, locked: false, lockedAt: 0, last: null, standby: null, voidAt: 0 };
  function e2Reset(all) {
    e2.contSince = null; e2.lowSince = null; e2.locked = false; e2.lockedAt = 0; e2.standby = null; e2.voidAt = 0;
    if (all) { e2.last = null; e2.lastCt = -1; e2.lastAt = 0; }
  }
  function e2Break() { e2.contSince = null; }
  function standbyOk(now) {
    var s = e2.standby;
    if (!s || isFailed(s.host, now) || s.host === effHost()) return false;
    if (now - s.at >= STANDBY_TTL_MS) return false;
    return !(now - s.at >= STANDBY_IDLE_MS && !(segFailAt > s.at));
  }
  function standbyTick(now) {
    if (!e2.standby || standbyOk(now)) return;
    jlog("fb.standby", { phase: "void", host: shortHost(e2.standby.host), age: Math.round((now - e2.standby.at) / 1000) });
    e2.standby = null; e2.voidAt = now;
  }
  function lockE2(why) { if (!e2.locked) jlog("fb.e2", { phase: "lock", by: why }); e2.locked = true; e2.lockedAt = Date.now(); e2.standby = null; }
  function e2Tick(now, v, block) {
    var playing = !!v && !v.paused && !v.ended && !v.seeking && v.readyState > 2 && !UI.stuck && !BLACK.base;
    var ct = v ? v.currentTime : -1;
    if (playing && e2.lastCt >= 0 && ct > e2.lastCt) { if (e2.contSince == null) e2.contSince = e2.lastAt || now; }
    else e2.contSince = null;
    e2.lastCt = ct; e2.lastAt = now;
    if (v && bufSec(v) < E2_LOW_SEC) { if (e2.lowSince == null) e2.lowSince = now; } else e2.lowSince = null;
    if (block) { e2.contSince = null; e2.lowSince = null; return; } // 被挡住期间的低缓冲不算进「持续 1 秒」
    var cont = e2.contSince != null && now - e2.contSince >= E2_CONT_MS;
    if (e2.locked && cont && e2.contSince > e2.lockedAt) { e2.locked = false; jlog("fb.e2", { phase: "unlock", by: "cont30" }); }
    if (FALLBACK.exhausted || R || autoTestRunning || !v || nearEndE2(v)) return;
    var low1 = e2.lowSince != null && now - e2.lowSince >= E2_LOW_HOLD_MS;
    // 缓冲掉到 3 秒以下（不用再满足连续播放 30 秒）：已有预备节点就把目前节点记失败、直接换过去。
    // 暂停中、跳转中、使用者操作后 8 秒内不算（拖到还没缓冲的地方，缓冲本来就是 0，不是节点的问题）
    if (low1 && e2SwitchOk(v, now) && standbyOk(now)) {
      var sb = e2.standby;
      markFailed(effHost(), PLAY_FAIL); e2.standby = null;
      applyRescuePick(sb.host, "standby");
      return;
    }
    if (!cont || e2.locked) return;
    var failRecent = segFailAt && now - segFailAt < E2_FAIL_RECENT_MS;
    var lr = e2.last && e2.last.host === effHost() ? e2.last : null;
    if (lr && now - lr.end < E2_GAP_MS) return; // 同一个节点两轮至少隔 60 秒
    if (failRecent) {
      if (lr && lr.kept && lr.trig === "fail" && !(segFailAt > lr.end)) return; // 上一轮目前节点还行：要有那之后的新失败
      if (low1) { startE2("fail", "rescue"); return; }
      if (e2.standby) return;
      if (e2.voidAt && !(segFailAt > e2.voidAt)) return; // 预备节点作废后，要有作废之后才发生的新失败
      startE2("fail", "bg");
    } else if (low1) startE2("buf", "rescue");
  }
  var e2NoSampleAt = 0;
  // 入口二因为缓冲低而换节点前：暂停中、跳转中、使用者操作后 8 秒内（拖到还没缓冲的地方，缓冲本来就是 0）、接近片尾，都不换
  // 入口二要先测的「目前节点」
  function e2CurHost() { return isHostMode() ? effHost() : (debug.currentCdn && CDN_HOST_RE.test(debug.currentCdn) ? debug.currentCdn : ""); }
  function e2SwitchOk(v, now) {
    if (!v || v.paused || v.seeking || nearEndE2(v)) return false;
    var lastOp = userOps.length ? userOps[userOps.length - 1] : 0;
    return !(lastOp && now - lastOp < USER_OP_GRACE_MS);
  }
  function startE2(trig, kind) {
    var now = Date.now();
    if (now - e2NoSampleAt < 10000) return; // 刚刚才测不了：不要每秒重试、洗日志
    // 没有候选、也没有目前的节点可测（B 站备用URL 模式还没抓过分段）：等于候选用完 → 上锁
    if (!listCands().length && !e2CurHost()) { lockE2("no-cand"); return; }
    if (startRound(2, trig === "fail" ? "seg-fail" : "low-buffer", kind, trig, listCands())) return;
    e2NoSampleAt = now;
    jlog("fb.noSample", { entry: 2 });
  }

  // ---------------- 救援测速：同时只跑一轮 ----------------
  // R：进行中的一轮 { src：1（入口一）／2（入口二）, kind：rescue／bg（背景预测速）, from：开测时的节点, hosts, i, measuring, results, best }
  // 入口二的每一轮先测目前的节点（≥ floor 就到此为止、不换）；入口一不测目前的节点（它刚在实际播放时失败）。
  // 单位都是 bytes/s：floor＝码率 × 1.5（码率已含播放速度）；good＝max(floor, min(UHD_BPS, 2 × 码率))；拿不到码率时 floor＝0、good＝UHD_BPS
  var R = null;
  function startRound(src, reason, kind, trig, cands) {
    // 样本网址的签名已过期（暂停太久）：每个节点都会 403，测了会误判成「都不流畅」→ 当成测不了
    if (R || speedTestRunning || autoTestRunning || !sampleUrl() || isExpiredUrl(sampleUrl())) return false;
    var from = effHost();
    var testable = cands.filter(function (h) { return !!testUrlFor(h); }); // akamai 没有这个档案的专属网址就测不了
    // 入口二先测目前的节点：具名节点就测它；B 站备用URL 模式测实际在抓分段的那个节点（测不了就不跑这一轮）
    var curHost = src === 2 ? e2CurHost() : "";
    if (src === 2 && !curHost) return false;
    if (curHost) testable = testable.filter(function (h) { return h !== curHost; });
    var hosts = (curHost ? [curHost] : []).concat(testable);
    if (!hosts.length) return false;
    if (curHost && !testUrlFor(curHost)) return false;
    var testCur = !!curHost;
    if (src === 1 && !testable.length) return false;
    var need = currentBitrateBps(), floor = need * RESCUE_HEADROOM;
    var good = need ? Math.max(floor, Math.min(UHD_BPS, need * RESCUE_GOOD_X)) : UHD_BPS;
    stMaxBytes = clampNum(cfg.stVideoMb, 1, 100, ST_DEFAULT_MB) * 1024 * 1024;
    stMaxMs = clampNum(cfg.stVideoSec, 1, 60, ST_DEFAULT_SEC) * 1000;
    var maxMs = hosts.length * stMaxMs + AUTO_TEST_SLACK_MS;
    var r = R = { src: src, reason: reason, kind: kind, trig: trig, from: from, forKey: mediaKey, forPath: location.pathname, hadPlayer: !!window.player,
      floor: floor, good: good, hosts: hosts, i: 0, measuring: null, results: [], best: null, gen: ++speedTestGen, over: false, aborted: "", deadline: Date.now() + maxMs };
    autoTestRunning = true;
    jlog("fb.optimize", { entry: src, kind: kind, reason: reason, from: shortHost(from), n: testable.length, needKbps: floor ? Math.round(floor / 1024) : "", goodKbps: Math.round(good / 1024) });
    var early = { ttfbMs: RESCUE_TTFB_MS, minBps: floor / 2, checkMs: RESCUE_SLOW_CHECK_MS };
    var watchdog = setTimeout(function () {
      if (r.over) return;
      if (r.aborted) { end(r.aborted); return; }
      jlog("ui.speedtest", { phase: "timeout", kind: "rescue", tested: r.i });
      speedTestGen++; // 还在测的那个节点回来时自行退出
      if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
      finish(true);
    }, maxMs);
    function end(how, res) {
      if (r.over) return;
      r.over = true;
      clearTimeout(watchdog);
      if (R === r) R = null;
      autoTestRunning = false;
      noteLift();
      if (!speedTestRunning) speedTestAbort = null; // 手动测速已经开始（取代、或按了手动测速中止这一轮）：speedTestAbort 是对方的，不能动
      onRoundEnd(r, how, res || null);
    }
    function interrupted() { end(r.aborted || "replaced"); }
    function finish(timedOut, kept, pick) {
      if (r.over) return;
      if (tabHidden()) { end("hidden"); return; }
      if (!kept && !pick && r.best && r.best.bps >= r.floor) pick = r.best.host;
      end("done", { kept: !!kept, pick: pick || "", results: r.results.slice(), complete: !timedOut, timedOut: !!timedOut });
    }
    (function next() {
      if (r.over) return;
      if (r.gen !== speedTestGen) { interrupted(); return; }
      if (r.i >= r.hosts.length) { finish(false); return; }
      var idx = r.i++, host = r.hosts[idx];
      r.measuring = host;
      measureHost(host, early).then(function (x) {
        r.measuring = null;
        if (r.over) return;
        if (r.gen !== speedTestGen) { interrupted(); return; }
        var ok = !x.error && x.bps > 0;
        if (testCur && idx === 0) {
          if (r.src === 1) { next(); return; } // 测目前节点的途中被改成入口一触发：丢掉这个结果
          jlog("fb.testCur", { host: shortHost(host), kbps: Math.round(x.bps / 1024), err: x.error || "", ok: ok && x.bps >= r.floor ? 1 : 0 });
          if (ok && x.bps >= r.floor) { finish(false, true); return; } // 目前的节点还可以播：这一轮到此为止
          next(); return;
        }
        r.results.push(x);
        if (ok && (!r.best || x.bps > r.best.bps)) r.best = x;
        if (ok && x.bps >= r.good) { finish(false, false, host); return; }
        next();
      });
    })();
    return true;
  }
  // 中止进行中的救援测速、丢弃结果（切到背景、关掉自动优化、手动测速、换影片、使用者手动换节点）
  function abortRescue(by) {
    if (!R || R.over) return;
    R.aborted = by;
    jlog("ui.speedtest", { phase: "stop", kind: "rescue", by: by });
    speedTestGen++;
    if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
  }
  function onRoundEnd(r, how, res) {
    var now = Date.now();
    if (how !== "done" || !res) { jlog("fb.drop", { reason: how }); return; }
    checkVideoKey();
    // 套用前再检查一次：换了影片、换了页、播放器暂时不在（SPA 换页会拆掉重建，player.reload() 不能用）、节点被使用者换掉、或现在不该救援
    var blocked = rescueBlocked(now);
    // 使用者操作后的冷却中：入口二的结果留作预备节点（目前节点不记失败），入口一的结果不套用
    var userCool = blocked === "user-op";
    var drop = r.forKey != null && mediaKey !== r.forKey ? "next-video" : location.pathname !== r.forPath ? "page-changed"
      : r.hadPlayer && !window.player ? "player-gone" : effHost() !== r.from ? "node-changed" : (userCool && r.src === 2 ? "" : blocked);
    if (drop) { jlog("fb.drop", { reason: drop, pick: res.pick ? shortHost(res.pick) : "" }); return; }
    // 不到 floor 或被放弃的记失败 1 分钟；≥ floor 没选上的不记
    res.results.forEach(function (x) {
      if (x.host === res.pick || x.host === r.from) return;
      if (!x.error && x.bps > 0 && x.bps >= r.floor) return;
      markFailed(x.host, TESTED_FAIL_TTL_MS);
    });
    if (r.src === 2) e2.last = { end: now, trig: r.trig, host: r.from, kept: res.kept };
    if (res.kept) { jlog("fb.keep", { host: shortHost(r.from), trig: r.trig }); return; }
    var v = getMainVideo(), buf = bufSec(v);
    if (res.pick) {
      if (r.src === 1) { applyRescuePick(res.pick, r.reason); return; }
      // 入口二：缓冲掉到 3 秒以下才换；缓冲还够，最近 20 秒仍有分段失败就留作预备节点，没有就丢掉
      if (buf < E2_LOW_SEC && !userCool && e2SwitchOk(v, now)) { markFailed(r.from, PLAY_FAIL); applyRescuePick(res.pick, r.reason); return; }
      if (buf < E2_LOW_SEC || userCool) { e2.standby = { host: res.pick, at: now }; jlog("fb.standby", { phase: "set", host: shortHost(res.pick), why: "user-busy" }); return; }
      if (segFailAt && now - segFailAt < E2_FAIL_RECENT_MS) { e2.standby = { host: res.pick, at: now }; jlog("fb.standby", { phase: "set", host: shortHost(res.pick), buf: buf.toFixed(1) }); }
      else jlog("fb.discard", { pick: shortHost(res.pick), buf: buf.toFixed(1) });
      return;
    }
    jlog("fb.noPick", { entry: r.src, kind: r.kind, tested: res.results.length, complete: res.complete ? 1 : 0 });
    if (r.src === 1) { if (res.complete) terminalOrExhaust(r.reason); return; } // 逾时没测完：这一轮不换，下次触发再试
    // 入口二：测完都没有 ≥ floor（背景预测速逾时也算）就上锁；救援测速结束时缓冲已回到 3 秒以上不上锁
    if (r.kind === "rescue" && buf >= E2_LOW_SEC) return;
    if (res.complete || r.kind === "bg") lockE2(res.complete ? "no-pick" : "bg-timeout");
  }

  // ---------------- 终态提示：所有节点都不流畅 ----------------
  // 10 秒倒数，「继续观看」（按下或倒数结束）＝这支影片不再自动优化；「关闭介入」＝整页重新整理，这个分页回到 B 站原始行为。
  // 挂在 .bpx-player-container 里（全屏也看得到），B 站重建播放器 DOM 时重新挂上；显示期间这个分页不侦测；分页在背景时倒数暂停
  var term = null; // { el, bar, left, lastAt, reason }
  function termHost() { return uiContainer() || ((getMainVideo() || {}).parentElement) || null; }
  function showTerminal(reason) {
    if (term) return;
    var host = termHost();
    if (!host) return;
    hideToast();
    var el = document.createElement("div");
    el.id = "cdn-switcher-terminal";
    el.style.cssText = ["position:absolute", "left:50%", "top:50%", "transform:translate(-50%,-50%)", "z-index:2147483000",
      "box-sizing:border-box", "max-width:88%", "width:420px", "padding:14px 16px 12px", "border-radius:10px",
      "background:rgba(0,0,0,.82)", "color:#fff", "font:14px/1.6 " + TOAST_FONT, "box-shadow:0 4px 16px rgba(0,0,0,.4)",
      "pointer-events:auto", "text-align:left"].join(";");
    var txt = document.createElement("div");
    txt.textContent = MSGS.mhTermText;
    el.appendChild(txt);
    var track = document.createElement("div");
    track.style.cssText = "height:4px;border-radius:2px;background:rgba(255,255,255,.2);margin:10px 0 12px;overflow:hidden";
    var bar = document.createElement("div");
    bar.style.cssText = "height:100%;width:100%;background:#00aeec";
    track.appendChild(bar);
    el.appendChild(track);
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap";
    var bc = document.createElement("button");
    bc.type = "button"; bc.textContent = MSGS.mhTermContinue;
    bc.style.cssText = "cursor:pointer;border:0;border-radius:6px;padding:6px 14px;font:13px " + TOAST_FONT + ";background:#00aeec;color:#fff";
    var bo = document.createElement("button");
    bo.type = "button"; bo.textContent = MSGS.mhTermDisable;
    bo.style.cssText = "cursor:pointer;border:1px solid rgba(255,255,255,.5);border-radius:6px;padding:6px 14px;font:13px " + TOAST_FONT + ";background:transparent;color:#fff";
    // 不要让点击穿透到播放器（点画面会暂停／播放）
    ["click", "pointerdown", "mousedown", "dblclick"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    bc.addEventListener("click", function () { termChoose("continue", "click"); });
    bo.addEventListener("click", function () { termChoose("disable", "click"); });
    row.appendChild(bo); row.appendChild(bc);
    el.appendChild(row);
    term = { el: el, bar: bar, left: TERM_MS, lastAt: Date.now(), reason: reason, timer: null };
    termAttach();
    term.timer = setInterval(function () { termTick(Date.now()); }, 200);
    debug.lastError = "auto-fallback(" + reason + "): " + effHost() + " -> terminal";
    jlog("ui.term", { phase: "show", reason: reason, failed: failedHosts().length });
  }
  function termAttach() {
    if (!term) return;
    var host = termHost();
    if (!host) return;
    if (term.el.parentElement !== host) {
      try { if (getComputedStyle(host).position === "static") host.style.position = "relative"; } catch (e) {}
      host.appendChild(term.el);
    }
  }
  function termTick(now) {
    if (!term) return;
    termAttach();
    var dt = now - term.lastAt;
    // 分页在背景：倒数暂停；电脑睡眠、计时器被节流（中断超过 3 秒）的时间也不算
    if (!tabHidden() && dt > 0 && dt <= TICK_GAP_MS) term.left -= dt;
    term.lastAt = now;
    term.bar.style.width = Math.max(0, term.left / TERM_MS * 100) + "%";
    if (term.left <= 0) termChoose("continue", "timeout");
  }
  function closeTerminal(by) {
    if (!term) return;
    clearInterval(term.timer);
    if (term.el.parentElement) term.el.parentElement.removeChild(term.el);
    term = null;
    noteLift();
    if (by) jlog("ui.term", { phase: "close", by: by });
  }
  function termChoose(choice, by) {
    if (!term) return;
    closeTerminal("");
    jlog("ui.term", { choice: choice, by: by });
    if (choice === "continue") { FALLBACK.noMore = true; return; } // 用目前的节点继续播；这支影片不再自动优化（只在记忆体，换影片、重新整理就重来）
    try { window.sessionStorage.setItem(NOINT_KEY, "1"); window.sessionStorage.removeItem(AUTO_KEY); } catch (e) {}
    fullReload();
  }

  // ---------------- 每秒的侦测（点播）----------------
  // 条件不允许侦测时（rescueBlocked、入口一那轮测速中）：正卡着的那次开始时间一直往后推，条件解除时就从那一刻算；入口二重新等 30 秒
  function holdTimers(now) {
    if (e1.ep) e1.ep.start = Math.max(e1.ep.start, now); // 恢复的判断照常（moveFrom 不动）：测速中影片恢复了，这次卡顿要能结束
    if (BLACK.base) BLACK.base = Math.max(BLACK.base, now);
    if (stallState.stuckSince != null) stallState.stuckSince = Math.max(stallState.stuckSince, now);
  }
  var lastTickAt = 0, wasBlocked = false;
  var liftAt = 0; // 最近一次「不侦测」的条件解除的时间（测速结束、回到前景、popup 测速页关掉、终态提示关掉）
  function noteLift() { liftAt = Date.now(); }
  function rescueTick() {
    var now = Date.now();
    if (IS_LIVE_PAGE) { legacyCheckStall(); return; }
    var gap = lastTickAt && now - lastTickAt > TICK_GAP_MS;
    var prevTick = lastTickAt;
    lastTickAt = now;
    if (!ACTIVE || !WATCH_RE.test(location.pathname)) return;
    var v = getMainVideo();
    if (gap && !tabHidden()) {
      // 取样中断（电脑睡眠、分页被节流）：进行中的计时（卡顿、连续播放、全黑、排除期）从现在重新开始。
      // 分页在背景时不用管（本来就不侦测，回到前景时 onVisibility 会处理）
      if (e1.ep) {
        var inExcl = e1.ep.excl && !e1.ep.estAt && e1.ep.start > prevTick; // 中断时还在使用者操作的 8 秒排除期内：排除期重新开始
        e1.ep.start = inExcl ? now + USER_OP_GRACE_MS : Math.max(e1.ep.start, now);
        e1.ep.moveFrom = null; e1.ep.lastCt = null;
      }
      if (BLACK.base) BLACK.base = Math.max(BLACK.base, now);
      e2.contSince = null; e2.lowSince = null; e2.lastCt = -1;
      legacyReset();
    }
    uiObserve();
    uiMissingCheck(now, v);
    termTick(now);
    standbyTick(now);
    var block = rescueBlocked(now);
    var b1 = block || (R && R.src === 1 && !R.aborted ? "testing" : "") || (autoTestRunning && !R ? "install" : "");
    if (!UI.missing) uiSample(now);
    // 条件刚解除：正卡着的那次从解除的那一刻开始算（冷静期结束、测速结束、回到前景、popup 关掉；不是上一次被挡住的那一秒）。
    // 要在 e1Track 之前，不然这一秒会用被推到上一秒的开始时间算成立
    if (!b1 && wasBlocked) {
      var at = now;
      if (FALLBACK.coolUntil > prevTick && FALLBACK.coolUntil <= now) at = FALLBACK.coolUntil;
      var uc = userCoolUntil();
      if (uc > prevTick && uc <= now) at = Math.max(at === now ? 0 : at, uc);
      if (liftAt >= prevTick && liftAt <= now) at = Math.max(at === now ? 0 : at, liftAt);
      holdTimers(at);
    }
    wasBlocked = !!b1;
    if (!UI.missing) { e1Track(now, v, !!b1); blackTrack(now, v); }
    if (UI.missing) legacyCheckStall(b1);
    else if (b1) holdTimers(now);
    else {
      var st = e1Stats(now);
      if (st.n >= E1_TRIGGER_N || st.ms >= E1_TRIGGER_MS) rescue1(simulateStallUntil > now ? "simulated" : "stalled", st);
      else if (BLACK.base && now - BLACK.base >= BLACK_MS) rescue1("blackout");
    }
    e2Tick(now, v, block);
  }

  // ---------------- 旧的影片元素卡顿判断：直播、以及点播画面元素失效时的后备（ui.missing）----------------
  var stallState = { lastTime: -1, stuckSince: null, movedAt: 0 }; // movedAt：最后一次看到走针的时间
  // 点播播放中画面停住：不管线路上有没有资料在进来，停这么久就算卡
  var STALL_PLAYING_LIMIT_MS = 5000;
  // 例外：缓冲用光后播放器自己设成暂停（不会自己恢复走针），看线路：没资料进来 STALL_LIMIT_MS、还有资料进来 STALL_SLOW_LIMIT_MS。
  // STALL_LIMIT_MS 也用在直播、初载（readyState 0）抓不到资料
  var STALL_LIMIT_MS = 8000;
  var STALL_SLOW_LIMIT_MS = 15000;
  var TRICKLE_BPS = 50 * 1024; // 缓冲耗尽时，低于这个速度的「还有资料在动」不算在补缓冲（连 360P 都撑不住）
  var BUFPAUSE_CLEAR_SEC = 3; // 缓冲暂停期间缓冲长回这么多还没继续播 = 是使用者自己按的暂停
  // bufPause：最近一次暂停发生时前方缓冲 < 0.5 秒 → 是缓冲不够时播放器自己按的暂停，之后缓冲长回来也不能当成「使用者主动暂停」
  var health = { bufPause: false };
  // ongoing：后备模式触发救援后这次卡顿还没恢复（看到走针才清），终态要用它判断「还卡着」
  function legacyReset() { stallState.lastTime = -1; stallState.stuckSince = null; stallState.movedAt = 0; stallState.ongoing = false; }
  // 使用者主动暂停：暂停、前方还有缓冲，而且不是缓冲不够时播放器自己按的（点播才分；直播维持原样）
  function userPaused(v) {
    if (!IS_LIVE_PAGE && health.bufPause && v.paused && forwardBufferSec(v) >= BUFPAUSE_CLEAR_SEC) health.bufPause = false;
    return v.paused && hasForwardBuffer(v) && (IS_LIVE_PAGE || !health.bufPause);
  }
  // 播到片尾 1 秒内（还没 ended）：停住是正常的，不算卡
  function nearEnd(v) { var d = v.duration; return !!d && isFinite(d) && v.currentTime >= d - 1; }
  // 持续侦测「真的播不动」：currentTime 不前进。点播播放中停住只看停了多久（STALL_PLAYING_LIMIT_MS）；
  // 播放器自己暂停、直播、初载还要看线路上有没有资料在动。
  // 点播（后备模式）：block 是 rescueTick 算好的「不侦测」原因；使用者操作排除、触发后归零、测速中不触发照新规则
  function legacyCheckStall(block) {
    if (IS_LIVE_PAGE ? (!liveActive() || !cfg.autoFallback || tabHidden()) : !!block) {
      if (IS_LIVE_PAGE) legacyReset(); else holdTimers(Date.now());
      return;
    }
    var simulating = Date.now() < simulateStallUntil;
    var limit = STALL_LIMIT_MS;
    if (!simulating) {
      var v = getMainVideo();
      var now = Date.now();
      // 分段请求持续在送、却一直抓不到任何资料 → 线路死了
      var starving = (now - lastSegReqAt < 10000 && now - lastSampleAt > 5000 && lastSegReqAt > 0) || liveNoData(v, now);
      var trickling = now - lastSampleAt < 5000 && debug.speedBps < TRICKLE_BPS;
      if (v && (v.ended || (!IS_LIVE_PAGE && nearEnd(v)))) { legacyReset(); return; }
      // 手机版与 iPhone 的嵌入播放器的 video 是 preload=metadata：使用者还没按播放（readyState 1、paused、没有前向缓冲）不算卡
      if (IS_MOBILE_PLAYER && (!v || (v.paused && !v.played.length))) { legacyReset(); return; }
      if (!v || v.readyState === 0) {
        if (!starving && !trickling) { legacyReset(); return; }
        if (!starving) limit = 20000;
      } else if (userPaused(v)) {
        legacyReset(); return;
      } else if (!IS_LIVE_PAGE && v.paused && !hasPlayed(v)) {
        legacyReset(); return;
      } else {
        var t = v.currentTime;
        if (t !== stallState.lastTime) {
          // 卡住期间的走针、但前方缓冲很少（< 3 秒）、线路上也没有新资料：是使用者一直点进度条，不是恢复了 → 卡顿计时继续
          var noData = !IS_LIVE_PAGE && stallState.stuckSince != null && forwardBufferSec(v) < 3 && now - lastSampleAt > 5000;
          stallState.lastTime = t; stallState.movedAt = now;
          if (noData) return;
          stallState.stuckSince = null; stallState.ongoing = false;
          return;
        }
        if (IS_LIVE_PAGE) {
          // 直播维持原样：线路还有资料在动只是缓冲慢，宽限 20 秒；暂停中还在补的不算卡，只有几 kB/s 的细水长流照样计时
          if (now - lastSampleAt < 5000) {
            if (v.paused && !trickling) { stallState.stuckSince = null; return; }
            limit = 20000;
          }
        } else if (v.paused) {
          if (now - lastSampleAt < 5000) limit = STALL_SLOW_LIMIT_MS;
        } else {
          limit = STALL_PLAYING_LIMIT_MS;
        }
        // 从最后一次看到走针起算；只回溯 2 秒内的（背景分页的计时器会被节流）
        if (stallState.stuckSince == null && !IS_LIVE_PAGE && stallState.movedAt && now - stallState.movedAt < 2000) {
          stallState.stuckSince = excludeStart(stallState.movedAt);
        }
      }
    }
    stallState.limit = limit;
    if (stallState.stuckSince == null) stallState.stuckSince = IS_LIVE_PAGE ? Date.now() : excludeStart(Date.now());
    else if (Date.now() - stallState.stuckSince > limit) {
      stallState.stuckSince = null;
      stallState.hit = true;
      if (!IS_LIVE_PAGE) stallState.ongoing = true;
      var sv = getMainVideo();
      jlog("fb.stall", { phase: "hit", legacy: IS_LIVE_PAGE ? "" : 1, limit: limit / 1000, rs: sv ? sv.readyState : -1, paused: sv ? sv.paused : "", buf: sv ? forwardBufferSec(sv).toFixed(1) : "" });
      if (IS_LIVE_PAGE) maybeLiveFallback(simulating ? "simulated" : "stalled");
      else rescue1(simulating ? "simulated" : "stalled");
    }
  }

  // ---------------- 分段请求失败（HTTP 错误／网路错误，目前节点的）：记下来给入口二用 ----------------
  // 使用者跳转造成的取消不算（呼叫端已过滤 AbortError），过期网址的 403 不算（shouldFallbackOnStatus）
  function onSegFailure(reason) {
    var now = Date.now();
    lastSegFailAt = now;
    checkVideoKey();
    if (IS_LIVE_PAGE || !ACTIVE || tabHidden()) return; // 背景分页：不记（回到前景先给播放器自己恢复）
    if (!segFailAt || now - segFailAt > 5000) { var v = getMainVideo(); jlog("fb.segFail", { reason: reason, buf: v ? bufSec(v).toFixed(1) : "-" }); }
    segFailAt = now;
  }

  // 是否为「该被差替的分段请求」：具名节点模式、是分段、host 是 CDN、且尚未等于目标
  function isSwappableSeg(url) {
    checkVideoKey(); // 先确认还在同一支影片：换了影片的覆写要在判断「能不能换 host」之前就取消（akamai 要专属签章，判断跟换 host 要用同一个目标）
    if (!isHostMode()) return false;
    if (!SEG_RE.test(url)) return false;
    var h = hostOf(url);
    if (!h || !CDN_HOST_RE.test(h) || h === effHost()) return false;
    // akamai 要带它自己的 token，记不到这个档案在 akamai 的原始 URL 就留在原 host（硬换只会 403）
    return !needsOwnSig(effHost()) || !!knownUrlOn(url, effHost());
  }
  // 先确认播放器还在同一支影片（背景分页的每秒 tick 会被节流，换了影片的覆写要在导向分段前就取消）
  function swapSegHost(url) { checkVideoKey(); return urlOnHost(url, effHost()); }

  // 实测（2026-10）：bilivideo 自家节点（upos-* / cn-*）共用同一套签名，换 host 就能用；
  // akamai 的 URL 多一个 hdnts token，绑单一档案，换 host、借别的档案的 token 都是 403。
  // 所以解析 playurl 时记下每个档案在各 host 的原始 URL，换到那个 host 时优先用 B 站给的整条 URL。
  var SIG_HOST_RE = /(^|\.)akamaized\.net$/i;
  function needsOwnSig(host) { return SIG_HOST_RE.test(host || ""); }
  var hostUrls = {}, hostUrlCount = 0; // host + pathname -> B 站给的原始 URL
  function noteHostUrl(url) {
    var h = hostOf(url), p = pathOf(url);
    if (!h || !p || !CDN_HOST_RE.test(h)) return;
    if (hostUrlCount > 2000) { hostUrls = {}; hostUrlCount = 0; } // 只是快取，长时间连看就整份重来
    if (!hostUrls[h + p]) hostUrlCount++;
    hostUrls[h + p] = url;
  }
  function knownUrlOn(url, host) { return hostUrls[host + pathOf(url)] || null; }
  function urlOnHost(url, host) { return knownUrlOn(url, host) || replaceHost(url, host); }
  var swapLogged = false; // 每份 playurl 之後第一個被改寫的分段記一筆，證明分段層改寫真的生效
  function noteSwap(url) { if (!swapLogged) { swapLogged = true; jlog("cdn.segFirst", { host: shortHost(effHost()), seg: segName(url).replace(/^[^/]*/, "") }); } }
  function trackOf(url) { return typeof videoQnByPath[pathOf(url)] === "number" ? "v" : "a"; }

  // ---------------- 直播（live.bilibili.com）----------------
  // 实测结论：
  //  - 直播流（FLV 长连线、m3u8、m4s）都由页面 fetch 发出，路径含 /live-bvc/，host 形如
  //    d1--{ov|cn}-gotcha{N}[b].bilivideo.com。token 绑「集群号 N」、在同号的 ov / ovb / cn / cnb 之间通用，
  //    所以「换线路」= 把 host 改成同号的另一种变体；点播那套 upos 节点对直播一律 403/959，不能用。
  //  - 候选是动态的：集群号随房间而变，部分 cn…b 根本不存在 → 要先探测，不存在就退回 ov。
  //  - 换线路后用 window.livePlayer.reload() 让播放器以新 host 重新拉流（不整页重载）。
  //  - 直播开关随时动态判断（liveActive），不像一般影片那样要靠「载入当下」决定是否安装 hook，
  //    所以改线路/开关都不需要整页重载。
  var IS_LIVE_PAGE = location.hostname === "live.bilibili.com";
  var IS_MOBILE_PLAYER = location.hostname === "m.bilibili.com" || /^\/blackboard\/webplayer\//.test(location.pathname);
  var LIVE_ROUTES = ["ov", "ovb", "cn", "cnb"];
  var LIVE_PATH_RE = /\/live-bvc\//i;
  var LIVE_HOST_RE = /^((?:[a-z0-9]+--)?)(ov|cn)-gotcha(\d+)(b?)(\.[a-z0-9.-]+)$/i;
  var LIVE_STREAM_RE = /\.(flv|m3u8)$/i; // 串流入口（相对于 m4s 分片）：探测/测速用它
  var LIVE_FALLBACK_COOLDOWN_MS = 30000;
  var LIVE_PROBE_TIMEOUT_MS = 8000;

  function liveActive() { return !!cfg.enabled && cfg.liveEnabled !== false; }
  function liveRouteOf(c) { return LIVE_ROUTES.indexOf(c.liveRoute) >= 0 ? c.liveRoute : "ov"; }
  function liveSig(c) { return (c.enabled && c.liveEnabled !== false) ? "on:" + liveRouteOf(c) : "off"; }

  function newLiveState(roomKey) {
    return {
      roomKey: roomKey, cluster: null, prefix: "", suffix: "", protocol: null,
      sampleUrl: "", // 最近一次「页面原本要请求」的串流入口 URL（还没被我们改 host），测速/探测用
      origRoute: null, // 页面原本用的线路（API 分配的）
      avail: { ov: null, ovb: null, cn: null, cnb: null }, // null = 未知；true/false = 探测或实际请求得知
      autoRoute: null, // 失败自动切换的静默覆写：只影响这个房间，不写入用户设定
      activeHost: null, probed: false, probing: false,
      firstStreamAt: 0 // 这个房间第一次请求串流的时间：用来判断「从头到尾都没拿到资料」
    };
  }
  var live = newLiveState("");
  var liveFb = { lastAt: 0 };

  function effLiveRoute() { return live.autoRoute || liveRouteOf(cfg); }

  function liveInfo(url) {
    try {
      var u = new URL(url, location.href);
      if (!LIVE_PATH_RE.test(u.pathname)) return null;
      var m = LIVE_HOST_RE.exec(u.hostname);
      if (!m) return null;
      return {
        u: u, prefix: m[1], cluster: m[3], suffix: m[5], isStream: LIVE_STREAM_RE.test(u.pathname),
        route: m[2].toLowerCase() + (m[4] === "b" ? "b" : ""), isFlv: /\.flv$/i.test(u.pathname)
      };
    } catch (e) { return null; }
  }
  function liveHostFor(prefix, cluster, suffix, route) {
    return prefix + (route.charAt(0) === "c" ? "cn" : "ov") + "-gotcha" + cluster + (route.slice(-1) === "b" ? "b" : "") + suffix;
  }
  function liveHostsMap() {
    var out = {};
    for (var i = 0; i < LIVE_ROUTES.length; i++) out[LIVE_ROUTES[i]] = liveHostFor(live.prefix, live.cluster, live.suffix, LIVE_ROUTES[i]);
    return out;
  }

  // 换房间（SPA 换路径）或集群号变了：之前探测/回退的结论都不再适用
  function noteLiveRequest(li, absUrl) {
    var rk = location.pathname;
    if (live.roomKey !== rk || (live.cluster && live.cluster !== li.cluster)) { live = newLiveState(rk); liveFb.lastAt = 0; }
    live.cluster = li.cluster; live.prefix = li.prefix; live.suffix = li.suffix;
    if (li.isStream) {
      if (!live.firstStreamAt) live.firstStreamAt = Date.now();
      live.sampleUrl = absUrl;
      live.protocol = li.isFlv ? "flv" : "fmp4";
      live.origRoute = li.route;
      live.avail[li.route] = true; // 页面本来就在用它
    }
  }

  // 请求串流已超过 8 秒、video 却还没拿到任何资料（readyState 0）：线路是通的但没有码流（legacyCheckStall 的直播路径用）
  function liveNoData(v, now) {
    return IS_LIVE_PAGE && live.firstStreamAt > 0 && now - live.firstStreamAt > 8000 && (!v || v.readyState === 0);
  }

  // 目前是否「确定得到 CDN 网址」：popup 只有这时才显示各线路的具体 host
  function liveReady() {
    if (!IS_LIVE_PAGE || !live.sampleUrl || live.roomKey !== location.pathname) return false;
    var v = getMainVideo();
    return !!v && v.readyState >= 2;
  }

  function liveReload() {
    try {
      var p = window.livePlayer;
      if (p && typeof p.reload === "function") {
        var v = getMainVideo(), wasPlaying = !!v && !v.paused;
        p.reload();
        // 实测偶发：reload 后 video 停在 paused 不会自己继续（FLV 较常见）。原本在播放的话，稍后补一次 play()
        if (wasPlaying) {
          var tries = 0, iv = setInterval(function () {
            var cur = getMainVideo(); tries++;
            if (cur && cur.paused && cur.readyState >= 2) { try { var pr = cur.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} }
            if (tries >= 6) clearInterval(iv);
          }, 1000);
        }
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 返回该请求应改成的 host；不需要改（功能关闭、本来就是目标）回 null
  function liveTargetHost(li) {
    if (!liveActive()) return null;
    var host = liveHostFor(li.prefix, li.cluster, li.suffix, effLiveRoute());
    return host === li.u.hostname ? null : host;
  }

  function liveFallbackToOv(failedRoute) {
    live.avail[failedRoute] = false;
    if (live.autoRoute === "ov" || liveRouteOf(cfg) === "ov") return;
    live.autoRoute = "ov";
    liveFb.lastAt = Date.now();
    jlog("fb.switch", { live: 1, from: failedRoute, to: "ov" });
    showToast(MSGS.mhToastLiveFallback);
    renderOverlay(); postDebug();
  }

  // 失败自动切换（直播版）：目前线路播不动（持续一段时间没有码流）→ 切回国际线路(ov)。
  // 只针对「这个房间」，不动用户长期选的线路；已经是 ov 就没得退，不处理。
  function maybeLiveFallback(reason) {
    if (!IS_LIVE_PAGE || !liveActive() || !cfg.autoFallback || tabHidden()) return;
    var route = effLiveRoute();
    if (route === "ov") return;
    if (Date.now() - liveFb.lastAt < LIVE_FALLBACK_COOLDOWN_MS) return;
    debug.lastError = "live-fallback(" + reason + "): " + route + " -> ov";
    liveFallbackToOv(route);
    if (!liveReload()) { try { location.reload(); } catch (e) {} }
  }


  // 直播 fetch：记录页面原始请求；需要时改 host；改过的请求若失败（线路不存在 → DNS 失败，或 403 等）
  // 且开着「失败自动切换」，就地改回页面原本的 host 重试，并让之后的请求都改走 ov。
  function liveFetch(_fetch, self, input, init, li) {
    var abs = li.u.href;
    noteLiveRequest(li, abs);
    var target = liveTargetHost(li);
    if (!target) {
      if (li.isStream) { live.activeHost = li.u.hostname; debug.currentCdn = li.u.hostname; }
      return _fetch.call(self, input, init);
    }
    var nu = replaceHost(abs, target), req = nu;
    if (typeof input !== "string") { try { req = new Request(nu, input); } catch (e) { return _fetch.call(self, input, init); } }
    var route = effLiveRoute();
    debug.segRewriteCount++;
    if (li.isStream) { live.activeHost = target; debug.currentCdn = target; }
    var p = _fetch.call(self, req, init);
    if (!cfg.autoFallback || route === "ov") return p;
    function retry() {
      return _fetch.call(self, input, init).then(function (r2) {
        if (r2.ok) {
          // 这次请求照样就地改回页面原本的 host 重试（救的是这个请求）；背景分页不把这个房间改走 ov（见 tabHidden）
          if (!tabHidden()) liveFallbackToOv(route);
          if (li.isStream) { live.activeHost = li.u.hostname; debug.currentCdn = li.u.hostname; }
        }
        return r2;
      });
    }
    return p.then(function (resp) {
      return resp.ok ? resp : retry();
    }, function (err) {
      if (err && err.name === "AbortError") throw err; // 播放器自己中止（换台/seek）不是线路问题
      return retry();
    });
  }

  // 探测某条线路在这个房间是否存在：拿目前的串流入口 URL 换 host 请求，拿到 2xx 就算存在（拿到 header 立刻中止）
  function probeLiveRoute(route) {
    return new Promise(function (resolve) {
      var url;
      try { url = replaceHost(live.sampleUrl, liveHostFor(live.prefix, live.cluster, live.suffix, route)); } catch (e) { resolve(false); return; }
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, LIVE_PROBE_TIMEOUT_MS);
      NATIVE_FETCH(url, { signal: ctrl.signal, cache: "no-store" }).then(function (resp) {
        clearTimeout(timer);
        var ok = resp.ok;
        try { ctrl.abort(); } catch (e) {} // 不用把整个串流拉下来
        resolve(ok);
      }, function () { clearTimeout(timer); resolve(false); });
    });
  }

  // popup 开着时才探测（懒探测：刷直播的人不会每进一个房间就多打三条连线）
  function probeLiveAvail() {
    if (!IS_LIVE_PAGE || live.probing || live.probed || !live.sampleUrl) return;
    live.probing = true;
    var st = live;
    Promise.all(LIVE_ROUTES.map(function (r) { return r === st.origRoute ? Promise.resolve(true) : probeLiveRoute(r); })).then(function (res) {
      st.probing = false;
      if (live !== st) return; // 探测期间换房间了
      for (var i = 0; i < LIVE_ROUTES.length; i++) st.avail[LIVE_ROUTES[i]] = res[i];
      st.probed = true;
      postDebug();
    });
  }

  // ---------------- 锁定同一批节点（直播 playurl 快取）----------------
  // 每次切线路都要 livePlayer.reload()，播放器会重打 getRoomPlayInfo，B 站可能回另一个集群号 →
  // 测的是 07、切过去播的却是 05（cn 是不同实体节点，甚至没有 cn-b）。
  // 做法：同一个直播间、同样参数的 getRoomPlayInfo，签名还没快过期就直接回上次那份，集群号与签名都不变；
  // 换线路只是在这份网址上改 host（同号的 ov/ovb/cn/cnb 共用签名）。
  //  - 进房第一份不是 API 打的，是页面 SSR 塞的 __NEPTUNE_IS_MY_WAIFU__.roomInitRes（格式与 API 回应相同），
  //    第一次 reload 时拿它当快取，进房后的集群号就一路固定。
  //  - 签名约 60 分钟过期：剩不到 2 分钟就放行、让 B 站给新的一份（这时才可能换号）。
  //  - 播放器出错自己重试时（req_reason 不是 0）、或 20 秒内已经连回 6 次快取（正常手动切线路不会这么密，
  //    多半是播放器在死循环重试），一律放行，免得整批节点挂掉时被快取卡住。
  //  - 「关闭」直播时完全不介入。
  var PLAYINFO_RE = /\/xlive\/web-room\/v2\/index\/getRoomPlayInfo/i;
  var PLAYINFO_MIN_LEFT_S = 120;
  var playInfoCache = {}; // key -> 回应 JSON 字串
  var playInfoServedAt = [];

  function playInfoKey(q) {
    return [q.get("room_id"), q.get("qn") || "0", q.get("protocol"), q.get("format"), q.get("codec")].join("|");
  }
  function playInfoExpires(obj) {
    var min = Infinity;
    try {
      obj.data.playurl_info.playurl.stream.forEach(function (s) {
        s.format.forEach(function (f) {
          f.codec.forEach(function (c) {
            c.url_info.forEach(function (u) { var m = /expires=(\d+)/.exec(u.extra || ""); if (m) min = Math.min(min, +m[1]); });
          });
        });
      });
    } catch (e) { return 0; }
    return min === Infinity ? 0 : min;
  }
  function usablePlayInfo(obj) {
    return !!obj && obj.code === 0 && !!obj.data && obj.data.live_status === 1 && !!obj.data.playurl_info &&
      playInfoExpires(obj) - Date.now() / 1000 > PLAYINFO_MIN_LEFT_S;
  }
  function ssrPlayInfo(roomId) {
    try {
      var w = window.__NEPTUNE_IS_MY_WAIFU__, r = w && w.roomInitRes;
      if (r && r.data && (String(r.data.room_id) === roomId || String(r.data.short_id) === roomId)) return JSON.stringify(r);
    } catch (e) {}
    return null;
  }
  function parseOrNull(txt) { try { return JSON.parse(txt); } catch (e) { return null; } }

  function playInfoFetch(_fetch, self, input, init, u) {
    var q = u.searchParams, key = playInfoKey(q), now = Date.now();
    var reason = q.get("req_reason");
    playInfoServedAt = playInfoServedAt.filter(function (t) { return now - t < 20000; });
    var txt = playInfoCache[key];
    if (!txt && (q.get("qn") || "0") === "0") txt = ssrPlayInfo(q.get("room_id") || "");
    if (txt && usablePlayInfo(parseOrNull(txt)) && (!reason || reason === "0") && playInfoServedAt.length < 6) {
      playInfoCache[key] = txt;
      playInfoServedAt.push(now);
      debug.playInfoPinned++;
      return Promise.resolve(new Response(txt, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }));
    }
    return _fetch.call(self, input, init).then(function (resp) {
      resp.clone().text().then(function (t2) { if (usablePlayInfo(parseOrNull(t2))) playInfoCache[key] = t2; }).catch(function () {});
      return resp;
    });
  }

  function liveSnapshot() {
    if (!IS_LIVE_PAGE) return null;
    var ready = liveReady();
    return {
      ready: ready, route: liveRouteOf(cfg), eff: effLiveRoute(), auto: live.autoRoute,
      cluster: ready ? live.cluster : null, protocol: ready ? live.protocol : null, origRoute: ready ? live.origRoute : null,
      hosts: ready ? liveHostsMap() : null, avail: ready ? live.avail : null, activeHost: ready ? live.activeHost : null,
      pinned: debug.playInfoPinned
    };
  }

  // ---------------- playurl / playinfo 改写（让 baseUrl 也一致，次要）----------------
  function applyTrack(track) {
    var base = asStr(track.baseUrl) || asStr(track.base_url) || asStr(track.url);
    var backups = track.backupUrl || track.backup_url || [];
    if (!Array.isArray(backups)) backups = [];
    backups = backups.map(asStr).filter(Boolean);
    if (!base && !backups.length) return null;
    if (pendingBackupHosts && !pendingBackupHosts.length && base) {
      debug.playurlGiven = hostOf(base); // 第一個 track（video）原本的 host
    }
    noteBackupHost(base);
    for (var bi = 0; bi < backups.length; bi++) noteBackupHost(backups[bi]);
    if (base) noteHostUrl(base);
    for (var bj = 0; bj < backups.length; bj++) noteHostUrl(backups[bj]);
    var ordered;
    if (effHost() === "backup") {
      ordered = distinct(backups.concat([base])).filter(Boolean); // 优先 B 站给的备援节点
    } else {
      var swapped = base && (!needsOwnSig(effHost()) || knownUrlOn(base, effHost())) ? urlOnHost(base, effHost()) : "";
      ordered = distinct([swapped, base].concat(backups)).filter(Boolean);
    }
    if (!ordered.length) return null;
    var top = ordered[0], rest = ordered.slice(1);
    if ("baseUrl" in track || "base_url" in track || !("url" in track)) {
      track.baseUrl = top; if ("base_url" in track) track.base_url = top;
    } else { track.url = top; }
    track.backupUrl = rest; if ("backup_url" in track) track.backup_url = rest;
    return top; // 回传完整 URL（不只 host），让呼叫端自行取用
  }
  // foreign = 别支影片的 playurl（预载、预览，见 rewriteRoot）：只改写网址，正在播那支的画质／码率对照、测速样本、
  // 备援清单与 debug 都不动 —— 不然救援的门槛会照别支影片的码率算。对照表只追加（路径含 cid，不会跟正在播的冲突），
  // 播放器之后真的换过去时还查得到
  function rewriteContainer(d, foreign) {
    if (!d || typeof d !== "object") return false;
    var changed = false, vHost = null, aHost = null;
    var dash = d.dash;
    if (dash && typeof dash === "object") {
      if (!foreign) { videoQnByPath = {}; videoBwByPath = {}; } // 这份 dash 的所有画质档，重建路径→画质／码率对照
      eachTrack(dash.video, function (top, track) {
        changed = true; var h = hostOf(top);
        if (track && typeof track.id === "number") videoQnByPath[pathOf(top)] = track.id; // dash 的 id 即画质代码 qn
        if (track && typeof track.bandwidth === "number") videoBwByPath[pathOf(top)] = track.bandwidth;
        if (!vHost) { vHost = h; if (!foreign) noteEarlySample(top); }
      });
      eachTrack(dash.audio, function (top) { changed = true; if (!aHost) aHost = hostOf(top); });
      if (dash.dolby && Array.isArray(dash.dolby.audio)) eachTrack(dash.dolby.audio, function (top) { changed = true; if (!aHost) aHost = hostOf(top); });
      if (dash.flac && dash.flac.audio) { var top1 = applyTrack(dash.flac.audio); if (top1) { changed = true; if (!aHost) aHost = hostOf(top1); } }
    }
    if (Array.isArray(d.durl)) eachTrack(d.durl, function (top) { changed = true; var h = hostOf(top); if (!vHost) { vHost = h; if (!foreign) noteEarlySample(top); } });
    if (changed && !foreign) {
      debug.pickVideoHost = vHost || debug.pickVideoHost;
      debug.pickAudioHost = aHost || debug.pickAudioHost;
      if (typeof d.quality === "number") debug.lastQn = d.quality;
    }
    return changed;
  }
  function eachTrack(arr, onTop) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) { var top = applyTrack(arr[i]); if (top) onTop(top, arr[i]); }
  }
  function rewriteRoot(root, source) {
    var heldAutoHost = null, foreign = false;
    try {
      if (!root || typeof root !== "object") return false;
      var d = root.data || root.result || root;
      // 番剧/课程（pgc v2、SSR playurlSSRData）把 dash/durl 多包一层在 result.video_info 下
      if (d && typeof d === "object" && d.video_info && typeof d.video_info === "object" &&
          (d.video_info.dash || d.video_info.durl)) d = d.video_info;
      // 回退额度以「影片」为单位：player.reload() 后播放器会再打一次同一支影片的 playurl（2026-10 的回报日志），
      // 每份 playurl 都重置的话「最多切 2 次再问使用者」永远到不了，会在备援之间每 30 秒来回切。
      // 同一页换到下一支影片：救援的覆写只管卡住的那支影片，下一支回到使用者选的节点（见 noteVideoKey）。
      // 播放器读得到现在的影片时，只有「现在这支」的 playurl 算换影片；别支影片的（自动连播预载的、或播放器还没换过去的下一支）
      // 照使用者的节点改写，这支影片的覆写留着 —— 播放器真的换过去时由 checkVideoKey（每秒）取消
      var key = peekMediaKey(d), cur = key != null ? playerVideoKey() : null;
      if (key != null) {
        if (cur == null || cur === key) noteVideoKey(key, cur == null ? "playurl" : "player");
        else { foreign = true; if (autoHost && key !== mediaKey) { heldAutoHost = autoHost; autoHost = null; } }
      }
      pendingBackupHosts = [];
      var givenBefore = debug.playurlGiven;
      var changed = rewriteContainer(d, foreign);
      var given = debug.playurlGiven;
      if (foreign) debug.playurlGiven = givenBefore; // 问题回报的「原始」节点是正在播那支的
      if (changed) {
        if (foreign) {
          // 别支影片：不更新 debug、不送快照（覆写这时暂时拿掉了，送出去 popup 会以为没有覆写）
          jlog("cdn.rewrite", { src: source, orig: shortHost(given), to: effHost() === "backup" ? "backup" : shortHost(effHost()), dash: d && d.dash ? 1 : 0, foreign: 1, cid: key, pcid: cur });
        } else {
          if (pendingBackupHosts.length) backupHosts = pendingBackupHosts;
          debug.lastSource = source; debug.rewriteCount++; renderOverlay(); postDebug();
          swapLogged = false;
          jlog("cdn.rewrite", { src: source, orig: shortHost(debug.playurlGiven), to: effHost() === "backup" ? "backup" : shortHost(effHost()), backups: backupHosts.map(shortHost), dash: d && d.dash ? 1 : 0 });
        }
      }
      pendingBackupHosts = null;
      return changed;
    } catch (e) { debug.lastError = String(e); pendingBackupHosts = null; return false; }
    finally { if (heldAutoHost) autoHost = heldAutoHost; }
  }
  // 每秒：播放器换到别支影片了（自动连播、页内点下一支）就当成换影片 —— 别支影片的 playurl 不算（见 rewriteRoot）
  function checkVideoKey() { var k = playerVideoKey(); if (k != null) noteVideoKey(k, "player"); }
  function tryRewriteText(txt, source) {
    if (typeof txt !== "string" || !txt) return null;
    if (txt.indexOf("dash") < 0 && txt.indexOf("durl") < 0 && txt.indexOf("backupUrl") < 0 && txt.indexOf("backup_url") < 0) return null;
    var obj; try { obj = JSON.parse(txt); } catch (e) { return null; }
    if (!rewriteRoot(obj, source)) return null;
    try { return JSON.stringify(obj); } catch (e) { return null; }
  }

  // ---------------- 安装 hook（仅 ACTIVE 时）----------------
  // 各类型页面的 playurl 端点（实测自 player core bundle）：
  //  - 一般影片: x/player/wbi/playurl、x/player/playurl
  //  - 番剧:     pgc/player/web/v2/playurl（旧版无 v2）
  //  - 课程:     pugv/player/web/playurl
  var PLAYURL_RE = /(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/(v2\/)?playurl|pugv\/player\/web\/playurl)/i;

  function installHooks() {
    // __playinfo__（SSR 首个分 P）— CDN 重排启用时才需要
    if (ACTIVE) {
      try {
        if (window.__playinfo__) rewriteRoot(window.__playinfo__, "playinfo");
        else {
          var store;
          Object.defineProperty(window, "__playinfo__", {
            configurable: true,
            get: function () { return store; },
            set: function (v) { try { rewriteRoot(v, "playinfo"); } catch (e) {} store = v; }
          });
        }
      } catch (e) { debug.lastError = "playinfo hook: " + e; }
    }

    // fetch：速度量测（永远启用）+ 分段 host 差替 / playurl 改写（CDN 启用时）
    var _fetch = window.fetch;
    if (typeof _fetch === "function") {
      window.fetch = function (input, init) {
        var url = "";
        try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (e) {}
        if (IS_LIVE_PAGE) {
          if (PLAYINFO_RE.test(url) && liveActive()) {
            try { return playInfoFetch(_fetch, this, input, init, new URL(url, location.href)); } catch (e) {}
          }
          var li = liveInfo(url);
          if (li) return liveFetch(_fetch, this, input, init, li);
        }
        if (ACTIVE) {
          if (isSwappableSeg(url)) {
            var nu = swapSegHost(url);
            if (nu !== url) {
              debug.segRewriteCount++; noteSwap(nu);
              if (typeof input === "string") input = nu;
              else { try { input = new Request(nu, input); } catch (e) {} }
            }
          }
          if (PLAYURL_RE.test(url)) {
            return _fetch.call(this, input, init).then(function (resp) {
              return resp.clone().text().then(function (txt) {
                var out = tryRewriteText(txt, "playurl");
                if (out == null) return resp;
                return new Response(out, { status: resp.status, statusText: resp.statusText, headers: new Headers(resp.headers) });
              }).catch(function () { return resp; });
            });
          }
        }
        if (isSegUrl(url)) {
          var t0 = Date.now();
          noteSegReq(t0);
          var reqUrl = typeof input === "string" ? input : (input && input.url) || url;
          return _fetch.call(this, input, init).then(function (resp) {
            // fetch 拿到 header 就 resolve，body 还在下载：等复本读完才算这个请求结束
            resp.clone().arrayBuffer().then(function (buf) { addSample(buf.byteLength, Date.now() - t0, true); }).catch(function () {});
            if (!resp.ok) {
              jlog("net.http", { status: resp.status, host: shortHost(hostOf(reqUrl)), track: trackOf(reqUrl), expired: isExpiredUrl(reqUrl) ? 1 : 0 });
              if (shouldFallbackOnStatus(resp.status, reqUrl)) onSegFailure("http-" + resp.status);
            }
            return resp;
          }, function (err) {
            // 播放器 seek / 切画质会主动 abort 在飞的分段请求，不是线路问题
            if (!(err && err.name === "AbortError")) {
              jlog("net.error", { host: shortHost(hostOf(reqUrl)), track: trackOf(reqUrl), msg: String(err && err.message || err).slice(0, 60) });
              if (isCurrentSegHost(hostOf(reqUrl))) onSegFailure("network-error");
            }
            throw err;
          });
        }
        return _fetch.call(this, input, init);
      };
    }

    // XHR：分段 host 差替 +（次要）playurl 改写
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var proto = XHR.prototype;
      var open = proto.open, send = proto.send;
      var textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
      var respDesc = Object.getOwnPropertyDescriptor(proto, "response");
      proto.open = function (method, url) {
        try {
          if (IS_LIVE_PAGE && typeof url === "string") {
            // XHR 没有就地重试的办法，只做 host 改写（直播流实测都走 fetch，这里是保险）
            var xli = liveInfo(url);
            if (xli) {
              noteLiveRequest(xli, xli.u.href);
              var xt = liveTargetHost(xli);
              if (xt) { url = replaceHost(xli.u.href, xt); debug.segRewriteCount++; }
            }
          }
          if (ACTIVE && typeof url === "string" && isSwappableSeg(url)) { url = swapSegHost(url); debug.segRewriteCount++; noteSwap(url); }
          this.__cdnSwitcherUrl = url;
          this.__cdnSwitcherIsSeg = typeof url === "string" && isSegUrl(url);
        } catch (e) {}
        return open.call(this, method, url, arguments.length > 2 ? arguments[2] : true, arguments[3], arguments[4]);
      };
      proto.send = function () {
        var self = this, url = self.__cdnSwitcherUrl || "";
        if (self.__cdnSwitcherIsSeg) {
          var t0 = Date.now();
          noteSegReq(t0);
          self.addEventListener("load", function () {
            try {
              var bytes = 0;
              if (self.response instanceof ArrayBuffer) bytes = self.response.byteLength;
              else { var cl = self.getResponseHeader("content-length"); if (cl) bytes = parseInt(cl, 10) || 0; }
              addSample(bytes, Date.now() - t0, true);
              if (self.status >= 400) jlog("net.http", { status: self.status, host: shortHost(hostOf(url)), track: trackOf(url), expired: isExpiredUrl(url) ? 1 : 0 });
              if (shouldFallbackOnStatus(self.status, self.__cdnSwitcherUrl || "")) onSegFailure("http-" + self.status);
            } catch (e) {}
          });
          self.addEventListener("error", function () {
            jlog("net.error", { host: shortHost(hostOf(url)), track: trackOf(url), xhr: 1 });
            if (isCurrentSegHost(hostOf(self.__cdnSwitcherUrl || ""))) onSegFailure("network-error");
          });
        }
        if (ACTIVE && PLAYURL_RE.test(url) && textDesc && respDesc) {
          var cachedText = null, cachedObj = null, computed = false;
          var compute = function () {
            if (computed) return; computed = true;
            try {
              var rt = self.responseType;
              if (rt === "json") { var obj = respDesc.get.call(self); rewriteRoot(obj, "playurl"); cachedObj = obj; }
              else cachedText = tryRewriteText(textDesc.get.call(self), "playurl");
            } catch (e) { debug.lastError = "xhr compute: " + e; }
          };
          try {
            Object.defineProperty(self, "responseText", {
              configurable: true,
              get: function () { if (self.readyState === 4) { compute(); if (cachedText != null) return cachedText; } return textDesc.get.call(self); }
            });
            Object.defineProperty(self, "response", {
              configurable: true,
              get: function () {
                var rt = self.responseType;
                if (self.readyState === 4) {
                  if (rt === "json") { compute(); return cachedObj; }
                  if (rt === "" || rt === "text") { compute(); if (cachedText != null) return cachedText; }
                }
                return respDesc.get.call(self);
              }
            });
          } catch (e) { debug.lastError = "xhr defineProperty: " + e; }
        }
        return send.apply(this, arguments);
      };
    }
  }

  installHooks(); // 速度量测永远启用；CDN 改写只在 ACTIVE 时生效
  debug.hookAt = Math.round(performance.now());
  try {
    // hook 裝好前頁面已經打過 playurl → 那份 playurl 沒被改寫（document_start 通常趕得上，趕不上就是競態 bug）
    debug.playurlBeforeHook = performance.getEntriesByType("resource").some(function (e) { return PLAYURL_RE.test(e.name || ""); });
  } catch (e) {}
  jlog("page.hook", { active: ACTIVE ? 1 : 0, playinfo: window.__playinfo__ ? 1 : 0, ms: debug.hookAt, playurlBefore: debug.playurlBeforeHook ? 1 : 0 });

  // 主播放器 video 的播放错误（如解码/来源错误）：点播只记日志（B 站会显示错误画面，错误码 3001 才救援，见 uiStuckKind）；
  // 直播维持原样，视为目前线路播不动。页面上 hover 预览等其他 video 的错误与线路无关，不理会
  window.addEventListener("error", function (e) {
    try {
      var t = e && e.target;
      if (t && t.tagName === "VIDEO" && t === getMainVideo()) {
        jlog("play.error", { code: t.error && t.error.code, msg: (t.error && t.error.message || "").slice(0, 80) });
        if (IS_LIVE_PAGE) maybeLiveFallback("video-error");
      }
    } catch (err) {}
  }, true);

  // ---------------- 被动观测「当前 CDN」（不改变任何原生行为）----------------
  var lastSegUrl = ""; // 最近一个「已实际下载完」的 video 分段 URL，最准确，但要等播放器真的抓过分段才有
  var earlySegUrl = ""; // playurl/playinfo 一解析完就有：当前画质第一个 video track 的 URL，不用等开始播放
  var lastAudioSegUrl = ""; // audio（或认不出轨道的）分段：整档常只有几 MB，测速会在门槛前就下载完，只在没别的可用时才拿来测
  function noteEarlySample(url) { if (url) earlySegUrl = url; }
  function sampleUrl() { return lastSegUrl || earlySegUrl || lastAudioSegUrl; } // 手动测速用：优先用真实下载过的 video，没有才退回 early

  function noteSegment(url) {
    if (trackOf(url) === "v") lastSegUrl = url; else lastAudioSegUrl = url;
    maybeScheduleAutoTest();
    var q = videoQnByPath[pathOf(url)]; // 是 video 分段才会命中；audio 分段不动画质
    if (typeof q === "number" && q !== lastVideoQn) { if (lastVideoQn != null) jlog("play.qn", { from: lastVideoQn, to: q }); lastVideoQn = q; }
    var h = hostOf(url);
    if (h && h !== debug.currentCdn) {
      // 換到的 host 不是我們要的 → 是播放器自己換的（例如走了 backupUrl），不是擴充換的
      jlog("cdn.hostChange", { from: shortHost(debug.currentCdn), to: shortHost(h), by: (ACTIVE && isHostMode() && h !== effHost()) ? "player" : "ext" });
      debug.currentCdn = h; renderOverlay(); postDebug();
    }
  }
  try {
    var po = new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e.name || !isSegUrl(e.name)) continue;
        // 测速自己发的请求（NATIVE_FETCH）也会出现在这里：不是播放器在抓，不能当成「播放器换了节点」或线路样本
        if (stTestUrls[e.name]) { delete stTestUrls[e.name]; continue; }
        noteSegment(e.name);
        if (e.transferSize > 0 && e.duration > 0) addSample(e.transferSize, e.duration, false);
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch (e) {}

  // ---------------- 手动测速：拿「当前影片＋当前画质」的分段，逐一实测各节点速度 ----------------
  // 只在 popup 按下按钮时执行一次；不影响使用者当下选择的 CDN，跑完只回报结果给 popup 显示。
  // popup 离开测速页或关闭时会送 speedtest-stop，中止目前请求、不再排下一个节点。
  // 每个节点下载到 N MB 或测满 N 秒先到者为准；预设 8MB / 5 秒，使用者可在 popup 进阶设定调整，
  // 每次开测由 popup 带进来（clampNum 挡掉不合理的值）
  var ST_DEFAULT_MB = DEFAULTS.stVideoMb, ST_DEFAULT_SEC = DEFAULTS.stVideoSec; // single source: DEFAULTS at the top
  var stMaxBytes = ST_DEFAULT_MB * 1024 * 1024;
  var stMaxMs = ST_DEFAULT_SEC * 1000;
  function clampNum(v, min, max, dflt) { v = Number(v); return isFinite(v) && v > 0 ? Math.min(max, Math.max(min, v)) : dflt; }
  var speedTestRunning = false;
  var speedTestGen = 0; // 每次 runSpeedTest 递增一代；旧一轮尚未 resolve 的 continuation 比对到
                         // 不是目前这代就自行停手，避免「重新测速」把旗标重置後、旧的那轮又复活续跑
  var speedTestAbort = null; // 目前这一个节点的 AbortController，供外部中止用

  var stTestUrls = {}; // 测速发出的网址：PerformanceObserver 看到时略过（见 noteSegment 那段）
  // 拿来测某个 host 的网址：bilivideo 节点共用签名，换 host 就能测；akamai 要用 B 站给这个档案的那条 URL（自带 token），
  // 没有就测不了（回传 null）。样本本身是 akamai 的 URL 时，先换回 B 站给的 bilivideo URL 再换 host
  function testUrlFor(host) {
    var s = sampleUrl();
    if (!s || !host) return null;
    if (needsOwnSig(host)) return knownUrlOn(s, host);
    if (needsOwnSig(hostOf(s))) {
      var base = null;
      for (var i = 0; i < backupHosts.length && !base; i++) if (!needsOwnSig(backupHosts[i])) base = knownUrlOn(s, backupHosts[i]);
      if (!base) return null;
      s = base;
    }
    return replaceHost(s, host);
  }
  // early（救援用，画面正停着，不值得把每个慢节点测满 5 秒）：{ ttfbMs, minBps, checkMs }
  //  - ttfbMs 内连 header 都没回来 → 放弃（"slow-ttfb"）；
  //  - 测了 checkMs 以后平均速度还不到 minBps → 放弃（"too-slow"）
  function measureHost(host, early) {
    var testUrl = testUrlFor(host);
    if (!testUrl) return Promise.resolve({ host: host, bytes: 0, ms: 0, bps: 0, error: "no-url" });
    stTestUrls[testUrl] = 1;
    early = early || {};
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      speedTestAbort = ctrl;
      var done = false, received = 0, gotHeaders = false, earlyErr = null;
      // 计时到就直接结束这个节点（不等 fetch 被中止后自己 reject：卡死的连线不一定会马上 reject）
      function stop(err) { if (done) return; earlyErr = err; if (ctrl) { try { ctrl.abort(); } catch (e) {} } finish(received, null); }
      var timer = setTimeout(function () { stop(received > 0 ? null : "timeout"); }, stMaxMs);
      var ttfbTimer = early.ttfbMs ? setTimeout(function () { if (!gotHeaders) stop("slow-ttfb"); }, early.ttfbMs) : null;
      var slowTimer = early.minBps && early.checkMs ? setTimeout(function () {
        if (received / ((Date.now() - t0) / 1000) < early.minBps) stop("too-slow");
      }, early.checkMs) : null;
      function finish(bytes, error) {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(ttfbTimer); clearTimeout(slowTimer);
        if (earlyErr) error = earlyErr;
        var ms = Date.now() - t0;
        resolve({ host: host, bytes: bytes, ms: ms, bps: ms > 0 ? (bytes / ms) * 1000 : 0, error: error || null });
      }
      NATIVE_FETCH(testUrl, { signal: ctrl ? ctrl.signal : undefined, cache: "no-store" }).then(function (resp) {
        gotHeaders = true;
        if (!resp.ok) { finish(0, "http-" + resp.status); return; }
        if (!resp.body || !resp.body.getReader) { finish(0, "no-stream"); return; }
        var reader = resp.body.getReader();
        (function pump() {
          if (done) { try { reader.cancel(); } catch (e) {} return; } // 已经结束（逾时或提早放弃）：别再读
          reader.read().then(function (r) {
            if (r.done) { finish(received, received > 0 ? null : "no-data"); return; }
            received += (r.value && r.value.length) || 0;
            if (received >= stMaxBytes) { try { reader.cancel(); } catch (e) {} finish(received, null); return; }
            pump();
          }).catch(function () {
            // 5 秒到、AbortController 中止读取：期间有收到资料就当成实测速度回报，
            // 完全没收到任何 byte 才算超时
            if (ctrl && ctrl.signal.aborted) { finish(received, received > 0 ? null : "timeout"); return; }
            finish(received, received > 0 ? null : "read-error");
          });
        })();
      }).catch(function () {
        finish(0, (ctrl && ctrl.signal.aborted) ? "timeout" : "network-error");
      });
    });
  }

  // 取影片标题：og:title / document.title 在 B 站都会带「_哔哩哔哩_bilibili」这类站名後缀，统一去掉
  var TITLE_SUFFIX_RE = /[-_]\s*(哔哩哔哩|bilibili)[\s\S]*$/i;
  function cleanTitle(s) { s = asStr(s); var t = s.replace(TITLE_SUFFIX_RE, "").trim(); return t || s; }
  function getVideoTitle() {
    try {
      var og = document.querySelector('meta[property="og:title"]');
      if (og && asStr(og.content)) return cleanTitle(og.content);
      var mt = document.querySelector('meta[name="title"]');
      if (mt && asStr(mt.content)) return cleanTitle(mt.content);
      return cleanTitle(document.title);
    } catch (e) { return ""; }
  }

  // 重新测速：不管前一轮跑到哪，直接中断、开新的一代；旧一轮的 continuation 靠 gen 比对自行退出
  function runSpeedTest(hosts, limits) {
    limits = limits || {};
    stMaxBytes = clampNum(limits.mb, 1, 100, ST_DEFAULT_MB) * 1024 * 1024;
    stMaxMs = clampNum(limits.sec, 1, 60, ST_DEFAULT_SEC) * 1000;
    if (!sampleUrl()) {
      try { window.postMessage({ __cdnSwitcher: 1, dir: "speedtest-done", payload: { error: "no-sample" } }, "*"); } catch (e) {}
      return;
    }
    if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
    abortLiveTestCtrls();
    var myGen = ++speedTestGen;
    speedTestRunning = true;
    try { window.postMessage({ __cdnSwitcher: 1, dir: "speedtest-meta", payload: { title: getVideoTitle(), qn: qnText() } }, "*"); } catch (e) {}
    var i = 0;
    (function next() {
      if (myGen !== speedTestGen) return; // 已被更新一轮取代，不再回报也不再继续
      if (i >= hosts.length) {
        speedTestRunning = false;
        speedTestAbort = null;
        try { window.postMessage({ __cdnSwitcher: 1, dir: "speedtest-done", payload: {} }, "*"); } catch (e) {}
        return;
      }
      var host = hosts[i++];
      measureHost(host).then(function (r) {
        if (myGen !== speedTestGen) return;
        try { window.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: r }, "*"); } catch (e) {}
        next();
      });
    })();
  }

  // ---------------- 安装后第一支影片的自动优化：在节点清单里找一个够快的换过去 ----------------
  // 安装后第一支影片（installTestPending，background.js 安装时设），开播几秒后在背景跑一次。
  // 先测目前的节点，达到 4K 标准就不动（就算别的节点更快也不换）；没达到才依清单顺序测其余节点，
  // 第一个达标的就停下来选它，全部测完都没有达标才选最快的（还是目前的节点最快就不换）。选到的写进 storage（同用户自己换节点）。
  // 卡顿救援的测速另外写在 startRound（只换这个分页）。两者同时只跑一个（autoTestRunning）。
  // 过程向 bridge 回报开始／进度／结束（popup 开着就显示「当前节点速度不佳，优化中」）；
  // maxMs 是这一轮最长能跑多久：每个节点最多 stMaxMs（measureHost 的 timer 连线带下载一起算）× 节点数，再加一点余裕，到了不论测到哪都收掉。
  // 与手动测速共用 speedTestGen：popup 开始手动测速会让这一轮作废
  var AUTO_TEST_DELAY_MS = 5000;
  var autoTestRunning = false;
  var pendingTimer = null; // 「安装后第一支影片」那一次的排程
  var UHD_BPS = 25e6 / 8; // 4K 标准 25 Mbps（bytes/s），同 popup 的画质门槛、/analyze-cdn 的达标线
  var AUTO_TEST_SLACK_MS = 5000;
  function postAutoTest(dir, payload) {
    try { window.postMessage({ __cdnSwitcher: 1, dir: dir, payload: payload || {} }, "*"); } catch (e) {}
  }
  function maybeScheduleAutoTest() {
    if (IS_LIVE_PAGE || !ACTIVE || !isActive(cfg)) return;
    if (!WATCH_RE.test(location.pathname)) return;
    // 安装后第一支影片：等起播顺了再测，开始测的那一刻旗标就清掉，之后不论完成、失败或关分页都不会再测。
    // timer 到时还没样本的话 runAutoSpeedTest 不会开始，下一个分段进来会再排一次。
    // 还没有国家清单（安装时没查到 IP、popup 也还没打开过）就先不测
    if (cfg.installTestPending && (cfg.autoSpeedHosts || []).length) {
      if (autoTestRunning || pendingTimer) return;
      pendingTimer = setTimeout(function () {
        pendingTimer = null;
        // 背景分页不测（旗标留着）：回到前景时 visibilitychange 会再排一次
        if (cfg.installTestPending && isActive(cfg) && !tabHidden()) runAutoSpeedTest(cfg.autoSpeedHosts || [], "install");
      }, AUTO_TEST_DELAY_MS);
    }
  }
  // 以开始时的节点当 from：中途使用者自己换了节点，bridge 比对不符就不覆盖。onEnd(how)：这一轮结束（含中断）时呼叫
  function runAutoSpeedTest(hosts, reason, onEnd) {
    if (speedTestRunning || autoTestRunning || R || !hosts.length || !sampleUrl()) return false;
    if (!cfg.installTestPending || tabHidden()) return false;
    cfg.installTestPending = false; // 触发即清（bridge 收到 autotest-start 会写回 storage）
    var from = cfg.cdnHost;
    stMaxBytes = clampNum(cfg.stVideoMb, 1, 100, ST_DEFAULT_MB) * 1024 * 1024;
    stMaxMs = clampNum(cfg.stVideoSec, 1, 60, ST_DEFAULT_SEC) * 1000;
    hosts = [from].concat(hosts.filter(function (h) { return h !== from; })); // 先测目前的节点
    var maxMs = hosts.length * stMaxMs + AUTO_TEST_SLACK_MS;
    postAutoTest("autotest-start", { reason: reason, total: hosts.length, maxMs: maxMs });
    var myGen = ++speedTestGen;
    autoTestRunning = true;
    var best = null, i = 0, over = false, watchdog = null;
    jlog("ui.speedtest", { phase: "start", kind: "auto-" + reason, hosts: hosts.length });
    // how：done（测完，含逾时）／replaced（被手动测速取代）／hidden（分页被切到背景）
    function end(clearAbort, how) {
      if (over) return;
      over = true;
      clearTimeout(watchdog);
      autoTestRunning = false;
      noteLift();
      if (clearAbort) speedTestAbort = null; // 被手动测速取代时 speedTestAbort 已是对方的，不能动
      // 因为分页切到背景而作废：rerun 请 bridge 把 installTestPending 还回 storage，
      // 之后任何一个前景分页的影片都能接手补测（例如在新分页开推荐影片、没再回到这个分页）。
      // 直接关掉分页的话页面马上卸载，这则讯息多半送不出去，那一次优化就没了（跟以前一样）
      postAutoTest("autotest-end", how === "hidden" ? { reason: reason, rerun: 1 } : { reason: reason });
      if (onEnd) onEnd(how);
    }
    function interrupted() { end(false, autoTestHiddenGen === speedTestGen ? "hidden" : "replaced"); }
    // pick：提早停下来选的节点；没给就用测到最快的
    function finish(pick) {
      if (over) return;
      // 测完的那一刻分页在背景（例如逾时计时器刚好在切走后触发）：结果不套用，不写设定、不重载其他分页
      if (tabHidden()) { jlog("ui.speedtest", { phase: "stop", kind: "auto-" + reason, by: "hidden" }); end(true, "hidden"); return; }
      if (!pick && best) pick = best.host;
      pick = pick || "";
      jlog("ui.speedtest", { phase: "done", kind: "auto-" + reason, tested: i, best: shortHost(pick), kbps: best ? Math.round(best.bps / 1024) : "" });
      if (pick && pick !== from) postAutoTest("autotest-done", { host: pick, from: from, reason: reason });
      end(true, "done");
    }
    watchdog = setTimeout(function () {
      if (over) return;
      jlog("ui.speedtest", { phase: "timeout", kind: "auto-" + reason, tested: i });
      speedTestGen++; // 还在测的那个节点回来时自行退出
      if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
      finish();
    }, maxMs);
    (function next() {
      if (myGen !== speedTestGen) { interrupted(); return; } // 被手动测速取代、或切到背景
      if (i >= hosts.length) { finish(); return; }
      measureHost(hosts[i++]).then(function (r) {
        if (myGen !== speedTestGen) { interrupted(); return; }
        var ok = !r.error && r.bps > 0;
        if (ok && (!best || r.bps > best.bps)) best = r;
        postAutoTest("autotest-progress", { done: i, total: hosts.length });
        if (ok && r.bps >= UHD_BPS) { finish(r.host); return; }
        next();
      });
    })();
    return true;
  }
  // 分页被切到背景：这一轮自动测速（安装后那次、或救援测速）作废，结果不套用；也顺便把频宽还给使用者正在看的分页
  var autoTestHiddenGen = -1;
  function abortAutoTestHidden() {
    if (R) { abortRescue("hidden"); return; }
    if (!autoTestRunning) return;
    jlog("ui.speedtest", { phase: "stop", kind: "auto", by: "hidden" });
    autoTestHiddenGen = ++speedTestGen;
    if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
  }

  // ---------------- 直播测速 ----------------
  // 直播不能照搬点播的「拉 8MB 量吞吐」：FLV 是按码率推送，吞吐≈码率，量不出余量（研究报告 0.1 节）。
  // 改量两个互相独立的指标，并列给用户看、不合成单一分数：
  //  - 切台卡顿：发出请求 → 拿到第一个可播放内容的时间。FLV = 第一个音/视频 tag；fMP4 = m3u8 + 起播所需分片。连测 3 次取平均。
  //  - 持续观看：拉 8 秒，用播放缓冲模型估算「会掉队几秒」。起播后播放头每秒走 1 秒，缓冲见底就停下来等；
  //    累计停下来等的秒数 = max(0, 牆上经过秒 − 已收到节目秒) 在整段期间的最大值（Skorokhod reflection）。
  //    FLV 以 tag 时间戳算节目秒；fMP4 以分片下载完成的时刻与 #EXTINF 算，起播前先缓冲 3 片（同 hls.js 预设）。
  // 一律用 NATIVE_FETCH 绕开上面装的 fetch hook，也不影响用户目前选的线路；测速会与正在播放的直播抢频宽。
  var LIVE_DEFAULT_RUNS = 3, LIVE_DEFAULT_SECS = 8; // 使用者可在 popup 进阶设定调整，每次开测带进来
  var liveStartupRuns = LIVE_DEFAULT_RUNS;
  var LIVE_STARTUP_TIMEOUT_MS = 6000; // 单次起播（或持续测试等到第一份资料）超过这个时间算失败
  var liveSustainSecs = LIVE_DEFAULT_SECS;
  var LIVE_HLS_START_SEGS = 3;
  var liveTestCtrls = [];

  function newLiveTestCtrl(timeoutMs) {
    var c = new AbortController();
    c.__timer = timeoutMs ? setTimeout(function () { try { c.abort(); } catch (e) {} }, timeoutMs) : null;
    liveTestCtrls.push(c);
    return c;
  }
  function releaseLiveTestCtrl(c) {
    clearTimeout(c.__timer);
    var i = liveTestCtrls.indexOf(c);
    if (i >= 0) liveTestCtrls.splice(i, 1);
    try { c.abort(); } catch (e) {}
  }
  function abortLiveTestCtrls() { liveTestCtrls.slice().forEach(releaseLiveTestCtrl); }

  function ltErr(code) { var e = new Error(code); e.code = code; return e; }
  function ltCode(e, ctrl) { return (e && e.code) || (ctrl && ctrl.signal.aborted ? "timeout" : "network-error"); }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 只解 FLV 的 tag 头（类型 + 时间戳），不碰内容
  function FlvParser() { this.buf = new Uint8Array(0); this.headerDone = false; this.bad = false; }
  FlvParser.prototype.push = function (chunk) {
    var b = this.buf, tags = [], pos = 0;
    if (b.length) { var n = new Uint8Array(b.length + chunk.length); n.set(b); n.set(chunk, b.length); b = n; } else b = chunk;
    if (!this.headerDone) {
      if (b.length < 13) { this.buf = b; return tags; }
      if (b[0] !== 0x46 || b[1] !== 0x4c || b[2] !== 0x56) { this.bad = true; return tags; } // 不是 "FLV"
      var off = ((b[5] << 24) | (b[6] << 16) | (b[7] << 8) | b[8]) >>> 0;
      if (b.length < off + 4) { this.buf = b; return tags; }
      pos = off + 4; this.headerDone = true;
    }
    while (b.length - pos >= 11) {
      var size = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
      if (b.length - pos < 11 + size + 4) break;
      var ts = ((b[pos + 4] << 16) | (b[pos + 5] << 8) | b[pos + 6]) + b[pos + 7] * 16777216;
      tags.push({ type: b[pos] & 0x1f, ts: ts });
      pos += 11 + size + 4;
    }
    this.buf = b.subarray(pos);
    return tags;
  };
  function isAvTag(t) { return t.type === 8 || t.type === 9; } // 8 = 音频、9 = 视频（18 是 script/metadata，不算画面）

  function parseM3u8(text, baseUrl) {
    var segs = [], map = null, dur = 1, lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXTINF:") === 0) dur = parseFloat(line.slice(8)) || 1;
      else if (line.indexOf("#EXT-X-MAP:") === 0) { var m = /URI="([^"]+)"/.exec(line); if (m) map = new URL(m[1], baseUrl).href; }
      else if (line.charAt(0) !== "#") { segs.push({ url: new URL(line, baseUrl).href, dur: dur, key: line }); dur = 1; }
    }
    return { segs: segs, map: map };
  }
  async function liveHlsPlaylist(url, ctrl) {
    var resp = await NATIVE_FETCH(url, { signal: ctrl.signal, cache: "no-store" });
    if (!resp.ok) throw ltErr("http-" + resp.status);
    var text = await resp.text();
    if (text.indexOf("#EXTM3U") < 0) throw ltErr("no-stream");
    return parseM3u8(text, url);
  }
  async function liveHlsBytes(url, ctrl) {
    var resp = await NATIVE_FETCH(url, { signal: ctrl.signal, cache: "no-store" });
    if (!resp.ok) throw ltErr("http-" + resp.status);
    return (await resp.arrayBuffer()).byteLength;
  }

  async function liveFlvStartup(url) {
    var ctrl = newLiveTestCtrl(LIVE_STARTUP_TIMEOUT_MS), t0 = performance.now();
    try {
      var resp = await NATIVE_FETCH(url, { signal: ctrl.signal, cache: "no-store" });
      if (!resp.ok) throw ltErr("http-" + resp.status);
      if (!resp.body) throw ltErr("no-stream");
      var reader = resp.body.getReader(), parser = new FlvParser();
      for (;;) {
        var r = await reader.read();
        if (r.done) throw ltErr("no-data");
        var tags = parser.push(r.value);
        if (parser.bad) throw ltErr("no-stream");
        if (tags.some(isAvTag)) return performance.now() - t0;
      }
    } catch (e) { throw ltErr(ltCode(e, ctrl)); }
    finally { releaseLiveTestCtrl(ctrl); }
  }

  async function liveHlsStartup(url) {
    var ctrl = newLiveTestCtrl(LIVE_STARTUP_TIMEOUT_MS), t0 = performance.now();
    try {
      var pl = await liveHlsPlaylist(url, ctrl);
      if (!pl.segs.length) throw ltErr("no-data");
      var seg = pl.segs[Math.max(0, pl.segs.length - LIVE_HLS_START_SEGS)]; // 播放器从离直播边缘约 3 片处起播
      var jobs = [liveHlsBytes(seg.url, ctrl)];
      if (pl.map) jobs.push(liveHlsBytes(pl.map, ctrl));
      await Promise.all(jobs);
      return performance.now() - t0;
    } catch (e) { throw ltErr(ltCode(e, ctrl)); }
    finally { releaseLiveTestCtrl(ctrl); }
  }

  // 回传「掉队秒数」（>= 0）
  async function liveFlvSustain(url) {
    var ctrl = newLiveTestCtrl(LIVE_STARTUP_TIMEOUT_MS), endTimer = null;
    try {
      var resp = await NATIVE_FETCH(url, { signal: ctrl.signal, cache: "no-store" });
      if (!resp.ok) throw ltErr("http-" + resp.status);
      if (!resp.body) throw ltErr("no-stream");
      var reader = resp.body.getReader(), parser = new FlvParser();
      var w0 = null, baseTs = 0, media = 0, maxDef = 0;
      for (;;) {
        var r;
        try { r = await reader.read(); } catch (e) { if (w0 !== null) break; throw e; } // 8 秒到了被我们中止
        if (r.done) break;
        var now = performance.now();
        var tags = parser.push(r.value);
        if (parser.bad) throw ltErr("no-stream");
        tags = tags.filter(isAvTag);
        if (!tags.length) continue;
        if (w0 === null) {
          w0 = now; baseTs = tags[0].ts;
          clearTimeout(ctrl.__timer);
          endTimer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, liveSustainSecs * 1000);
        } else {
          // 这一批到达的时刻，播放头相对已收到节目秒的落差（批内各 tag 同时到达，只算一次）
          var def = (now - w0) / 1000 - media;
          if (def > maxDef) maxDef = def;
        }
        for (var i = 0; i < tags.length; i++) { var m = (tags[i].ts - baseTs) / 1000; if (m > media) media = m; }
      }
      if (w0 === null) throw ltErr("no-data");
      return Math.max(0, maxDef, liveSustainSecs - media);
    } catch (e) { throw ltErr(ltCode(e, ctrl)); }
    finally { clearTimeout(endTimer); releaseLiveTestCtrl(ctrl); }
  }

  async function liveHlsSustain(url, gen) {
    var ctrl = newLiveTestCtrl(LIVE_STARTUP_TIMEOUT_MS * 2), endTimer = null; // 起播缓冲阶段的总时限
    try {
      var pl = await liveHlsPlaylist(url, ctrl);
      if (!pl.segs.length) throw ltErr("no-data");
      var seen = {}, media = 0, maxDef = 0, i;
      var start = pl.segs.slice(-LIVE_HLS_START_SEGS);
      for (i = 0; i < pl.segs.length; i++) seen[pl.segs[i].key] = 1;
      if (pl.map) await liveHlsBytes(pl.map, ctrl);
      for (i = 0; i < start.length; i++) { await liveHlsBytes(start[i].url, ctrl); media += start[i].dur; }
      var w0 = performance.now();
      clearTimeout(ctrl.__timer);
      endTimer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, liveSustainSecs * 1000);
      while (gen === speedTestGen && performance.now() - w0 < liveSustainSecs * 1000) {
        var pl2;
        try { pl2 = await liveHlsPlaylist(url, ctrl); } catch (e) {
          if (ctrl.signal.aborted) break;
          await sleepMs(300); continue; // 偶发失败：下一轮再抓
        }
        var fresh = pl2.segs.filter(function (s) { return !seen[s.key]; });
        for (i = 0; i < fresh.length; i++) {
          seen[fresh[i].key] = 1;
          try { await liveHlsBytes(fresh[i].url, ctrl); } catch (e) { if (ctrl.signal.aborted) break; continue; }
          var def = (performance.now() - w0) / 1000 - media;
          if (def > maxDef) maxDef = def;
          media += fresh[i].dur;
        }
        if (ctrl.signal.aborted) break;
        await sleepMs(400);
      }
      return Math.max(0, maxDef, liveSustainSecs - media);
    } catch (e) {
      // 8 秒到时 abort 可能落在抓分片中途：起播已完成的话，这不算失败
      if (ctrl.signal.aborted && endTimer !== null) return Math.max(0, maxDef, liveSustainSecs - media);
      throw ltErr(ltCode(e, ctrl));
    }
    finally { clearTimeout(endTimer); releaseLiveTestCtrl(ctrl); }
  }

  function postSpeedtest(dir, payload) {
    try { window.postMessage({ __cdnSwitcher: 1, dir: dir, payload: payload || {} }, "*"); } catch (e) {}
  }

  async function runLiveSpeedTest(limits) {
    limits = limits || {};
    liveStartupRuns = Math.round(clampNum(limits.runs, 1, 10, LIVE_DEFAULT_RUNS));
    liveSustainSecs = clampNum(limits.sec, 3, 60, LIVE_DEFAULT_SECS);
    if (!liveReady()) { postSpeedtest("speedtest-done", { error: "no-sample" }); return; }
    if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
    abortLiveTestCtrls();
    var myGen = ++speedTestGen, st = live;
    speedTestRunning = true;
    var isFlv = st.protocol === "flv";
    postSpeedtest("speedtest-meta", { title: getVideoTitle(), qn: isFlv ? "FLV" : "HLS (fMP4)" });
    // 先确认四条线路在这个直播间是否都存在；不存在的不测、也不会出现在结果里
    var found = await Promise.all(LIVE_ROUTES.map(probeLiveRoute));
    if (myGen !== speedTestGen) return;
    var avail = {};
    for (var a = 0; a < LIVE_ROUTES.length; a++) { avail[LIVE_ROUTES[a]] = found[a]; if (live === st) st.avail[LIVE_ROUTES[a]] = found[a]; }
    if (live === st) st.probed = true;
    postSpeedtest("speedtest-avail", { avail: avail });
    if (!found.some(Boolean)) { speedTestRunning = false; postSpeedtest("speedtest-done", { error: "unavailable" }); return; }
    for (var i = 0; i < LIVE_ROUTES.length; i++) {
      var route = LIVE_ROUTES[i];
      if (!avail[route]) continue;
      var host = liveHostFor(st.prefix, st.cluster, st.suffix, route), url = replaceHost(st.sampleUrl, host);
      var samples = [], lastErr = null;
      for (var k = 0; k < liveStartupRuns; k++) {
        try { samples.push(await (isFlv ? liveFlvStartup(url) : liveHlsStartup(url))); } catch (e) { lastErr = e.code || "network-error"; }
        if (myGen !== speedTestGen) return;
        if (!samples.length && k >= 1) break; // 连续两次都连不上就不用再试了
        await sleepMs(200);
      }
      if (!samples.length) { postSpeedtest("speedtest-progress", { route: route, host: host, error: lastErr }); continue; }
      var avg = samples.reduce(function (s, v) { return s + v; }, 0) / samples.length;
      postSpeedtest("speedtest-progress", { route: route, host: host, startup: { avg: avg, samples: samples } });
      try {
        var lag = await (isFlv ? liveFlvSustain(url) : liveHlsSustain(url, myGen));
        if (myGen !== speedTestGen) return;
        postSpeedtest("speedtest-progress", { route: route, host: host, sustain: { lag: lag } });
      } catch (e) {
        if (myGen !== speedTestGen) return;
        postSpeedtest("speedtest-progress", { route: route, host: host, sustainError: e.code || "network-error" });
      }
    }
    if (myGen !== speedTestGen) return;
    speedTestRunning = false;
    postSpeedtest("speedtest-done", {});
  }

  function stopSpeedTest() {
    if (!speedTestRunning) return;
    speedTestGen++; // 让目前这一轮的 continuation 全部失效
    speedTestRunning = false;
    if (speedTestAbort) { try { speedTestAbort.abort(); } catch (e) {} }
    abortLiveTestCtrls();
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__cdnSwitcher !== 1) return;
    if (d.dir === "speedtest-run") {
      // popup 按了手动测速（目前视窗的作用中分页）：中断这个分页的一切自动优化，直到测速页关掉（speedtest-closed）
      if (!IS_LIVE_PAGE) {
        if (!FALLBACK.manualPause) jlog("fb.pause", { by: "manual-test" });
        FALLBACK.manualPause = true; abortRescue("manual-test"); closeTerminal("manual-test");
      }
      runSpeedTest((d.payload && d.payload.hosts) || [], d.payload && d.payload.limits);
      return;
    }
    if (d.dir === "speedtest-stop") { stopSpeedTest(); return; }
    // 测速页关掉（按返回、关掉 popup）：恢复自动优化；正卡着的那次从现在重新算（见 holdTimers）
    if (d.dir === "speedtest-closed") { if (FALLBACK.manualPause) { FALLBACK.manualPause = false; noteLift(); jlog("fb.pause", { phase: "end" }); } return; }
    // popup 在这个分页有救援覆写时点了使用者自己的节点：取消覆写、换回设定的节点
    if (d.dir === "auto-clear") { clearAutoHost("popup"); return; }
    if (d.dir === "livetest-run") { runLiveSpeedTest(d.payload && d.payload.limits); return; }
    if (d.dir === "debug-poll") { probeLiveAvail(); return; }
    if (d.dir === "debug-flush") { updateSpeed(); postDebug(); postSample(); return; } // 回報頁開啟：立刻給一份最新快照與採樣
    if (d.dir === "messages" && d.payload) { for (var mk in DEFAULT_MSGS) if (d.payload[mk]) MSGS[mk] = d.payload[mk]; return; }
  });

  // ---------------- 切换 CDN 时的重载策略 ----------------
  function effSig(c) { return isActive(c) ? ("on:" + c.cdnHost) : "off"; }
  // "base" / "backup" are modes, not hosts; otherwise it must be a bilibili CDN host or one of the
  // user's own nodes (custom hosts are not necessarily on a bilibili domain).
  function isAllowedCdnHost(h, userHosts) {
    if (typeof h !== "string" || !h) return false;
    if (h === "base" || h === "backup") return true;
    if (CDN_HOST_RE.test(h)) return true;
    return Array.isArray(userHosts) && userHosts.indexOf(h) >= 0;
  }
  var WATCH_RE = /\/(video|bangumi|list|festival|medialist|cheese|blackboard)\//i;

  // 播放器内重载：重新请求分段（会被分段 hook 导到新节点），保留全屏；并回到原进度
  var selfSeekUntil = 0; // playerReload 之后自己 seek 回原位置的这段时间：跳转不算使用者操作
  function playerReload() {
    try {
      var p = window.player;
      if (!p || typeof p.reload !== "function") return false;
      selfSeekUntil = Date.now() + 7000;
      jlog("play.state", { ev: "reload", by: "player" });
      var t = 0;
      try { t = (typeof p.getCurrentTime === "function" ? p.getCurrentTime() : (document.querySelector("video") || {}).currentTime) || 0; } catch (e) {}
      p.reload();
      if (t > 1 && typeof p.seek === "function") {
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          var cur = 0; try { cur = p.getCurrentTime(); } catch (e) {}
          if (cur && Math.abs(cur - t) < 2) { clearInterval(iv); return; }
          try { p.seek(t); } catch (e) {}
          if (tries > 20) clearInterval(iv);
        }, 300);
      }
      return true;
    } catch (e) { return false; }
  }

  // 「闲着」= 换节点不必 player.reload()：播完了、使用者自己按的暂停（前方还有缓冲）、或还没开始播。
  // 缓冲用光后播放器自己设的暂停不算闲着：那是卡住，不 reload 的话播放器不会再抓分段，
  // 新节点永远用不上 —— #41 测速选出最快的节点却没生效，7 秒后又被判卡顿、切去更慢的备援
  function mainVideoIdle() {
    var v = getMainVideo();
    if (!v) return false;
    if (v.ended) return true;
    if (!v.paused) return false;
    // 「还没开始播」要排除最近有分段失败的分页：真实 B 站播放器连续失败后会把 video 整个重置（currentTime 0、played 清空），
    // 看起来像没播过，其实是卡死；不 reload 的话手动换节点要等播放器自己重试（冒烟测试实测 14 秒）
    return userPaused(v) || (!hasPlayed(v) && !(lastSegFailAt && Date.now() - lastSegFailAt < SEG_FAIL_STUCK_MS));
  }

  // 整页重载（保留进度）：用于需要安装/移除 hook 的切换
  function fullReload() {
    try {
      if (!WATCH_RE.test(location.pathname) && !document.querySelector("video")) return;
      jlog("play.state", { ev: "reload", by: "page" });
      var url = new URL(location.href);
      var v = getMainVideo();
      if (v && isFinite(v.currentTime) && v.currentTime > 1) url.searchParams.set("t", String(Math.floor(v.currentTime)));
      location.replace(url.toString());
    } catch (e) { try { location.reload(); } catch (_) {} }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__cdnSwitcher !== 1 || d.dir !== "config") return;
    if (!d.payload) return;
    var beforeSig = effSig(cfg), beforeActive = ACTIVE, beforeEffHost = effHost(), beforeLiveSig = liveSig(cfg);
    var beforePending = !!cfg.installTestPending;
    // Tripwire, not a security boundary: everything MAIN world sees (this message, the localStorage
    // copy read by readCfg) is writable by page scripts, and a script that runs in the page could
    // wrap fetch itself anyway. The persistent path (storage) is guarded in bridge.js. This check
    // only drops hosts that are neither a CDN domain nor in the node list that arrives with the
    // same config (bridge pushes the whole cfg, so a newly added custom host and its list come together).
    if (d.payload.cdnHost !== undefined && !isAllowedCdnHost(d.payload.cdnHost, d.payload.autoSpeedHosts || cfg.autoSpeedHosts)) {
      jlog("page.cfg", { rejected: String(d.payload.cdnHost).slice(0, 60) });
      return;
    }
    for (var k in DEFAULTS) if (d.payload[k] !== undefined) cfg[k] = d.payload[k];
    // 这个分页按过「关闭介入」：照 B 站原始行为，设定怎么改都不重新整理、不重载播放器
    if (NO_INTERVENE) { renderOverlay(); return; }
    if (beforeSig !== effSig(cfg) || beforeLiveSig !== liveSig(cfg)) jlog("page.cfg", { sig: effSig(cfg), live: liveSig(cfg) });
    // 影片播放中才收到旗标（例如安装后先开着影片）：不等下一个分段，这支就排程测一次（有样本才会真的开始）
    if (cfg.installTestPending && !beforePending) maybeScheduleAutoTest();
    // 中途关掉「速度不佳时自动优化节点」：中止进行中的救援测速、关掉终态提示
    if (!cfg.autoFallback) { abortRescue("off"); closeTerminal("off"); }
    renderOverlay();
    if (IS_LIVE_PAGE) {
      // 直播页只看直播设定：开关/线路变了 → 自动回退的覆写作废，播放器内重载让新线路生效（不整页重载）
      if (beforeLiveSig !== liveSig(cfg)) {
        live.autoRoute = null; liveFb.lastAt = 0;
        if (live.sampleUrl) {
          liveReload();
          // 換線路（不含開／關）跟影片換節點一樣弹 toast 告知换到哪条线路
          if (beforeLiveSig !== "off" && liveActive()) {
            var rk = { ov: "liveRouteOv", ovb: "liveRouteOvB", cn: "liveRouteCn", cnb: "liveRouteCnB" }[liveRouteOf(cfg)];
            showToast(MSGS.mhToastSwitched.replace("{host}", MSGS[rk] || liveRouteOf(cfg)));
          }
        }
        postDebug();
      }
      return;
    }
    if (beforeSig === effSig(cfg)) return; // 只改了 showDebug / autoFallback 之类 → 不动（保留 autoHost）
    autoHost = null; // 用户手动改了节点/开关：自动回退的静默覆写作废，以用户选择为准
    // 所有收到新设定的分页都当成换节点：中止救援、丢弃结果、恢复自动优化、关掉终态提示，入口一归零、入口二解锁、30 秒冷静期。
    // 这个分页还没抓过任何分段（例如页面刚载入、bridge 第一次推设定）：不是「换掉正在用的节点」，不给冷静期，
    // 不然一开页面就遇到死节点时，前 30 秒的卡顿全被忽略（冒烟测试实测）
    onUserSwitched("manual");
    onNodeSwitched(lastSegReqAt > 0);
    var afterActive = isActive(cfg);
    // 换节点（手动或自动测速）会闪一下黑画面：跟失败自动切换一样弹 toast 告知换到哪个节点；
    // 只开/关重排不算换节点，不弹
    var switchedText = (beforeActive && afterActive && WATCH_RE.test(location.pathname))
      ? MSGS.mhToastSwitched.replace("{host}", cfg.cdnHost === "backup" ? MSGS.mhCdnTargetBackup : cfg.cdnHost) : "";
    if (beforeActive !== afterActive) {
      fullReload(); // 需安装/移除 hook（开/关重排、切到/离开「原始」）
    } else if (cfg.cdnHost === "backup" || beforeEffHost === "backup") {
      toastAfterReload(switchedText);
      fullReload(); // 「备用」走 playurl 层，需重打 playurl 才生效 → 整页重载
    } else if (!WATCH_RE.test(location.pathname) || mainVideoIdle()) {
      // 具名节点只靠分段层改导，之后的分段请求自然会走新节点，不重载也生效。节点存在 storage、所有分页共用，
      // 使用者手动换节点（或安装后那次测速）时，其他分页也会收到这次变更：暂停／播完的分页若跟着 player.reload()，
      // 影片会自己播起来（回报 #33）；非观看页（首页预览）也不必整页重载
    } else if (playerReload()) {
      if (switchedText) showToast(switchedText); // 具名节点：播放器内重载（分段层即时导向）
    } else {
      toastAfterReload(switchedText);
      fullReload();
    }
  });

  // 整页重载才生效的切换：toast 文字先放 sessionStorage，重载后等播放器出现再弹（读到就删）
  var SWITCH_TOAST_KEY = "__CDN_SWITCHER_SWITCH_TOAST__";
  function toastAfterReload(text) {
    if (!text) return;
    try { window.sessionStorage.setItem(SWITCH_TOAST_KEY, text); } catch (e) {}
  }
  (function showPendingSwitchToast() {
    var text = null;
    try { text = window.sessionStorage.getItem(SWITCH_TOAST_KEY); window.sessionStorage.removeItem(SWITCH_TOAST_KEY); } catch (e) {}
    if (!text) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (getToastHost() !== document.body || tries > 40) { clearInterval(iv); showToast(text); }
    }, 500);
  })();

  // ---------------- Debug overlay（仅在有播放器时，显示于其左上角）----------------
  var overlayEl = null;
  var PLAYER_SEL = [".bpx-player-video-area", ".bpx-player-container", "#bilibili-player", ".bpx-player-primary-area", "#live-player"];
  function getPlayerEl() {
    for (var i = 0; i < PLAYER_SEL.length; i++) { var e = document.querySelector(PLAYER_SEL[i]); if (e) return e; }
    return null;
  }
  function cdnTargetLabel() {
    if (cfg.cdnHost === "base") return MSGS.mhCdnTargetOriginal;
    if (cfg.cdnHost === "backup") return MSGS.mhCdnTargetBackup;
    return cfg.cdnHost;
  }
  function buildLiveDebugText() {
    var lines = [
      "mode=" + (liveActive() ? "on" : "off") + "  target=" + liveRouteOf(cfg)
    ];
    if (live.autoRoute) lines.push("auto-fallback -> " + live.autoRoute);
    lines.push(
      "cdn=" + (live.activeHost || "-"),
      "proto=" + (live.protocol || "-") + "  cluster=" + (live.cluster || "-") + "  orig=" + (live.origRoute || "-") + "  seg=" + debug.segRewriteCount + "  pin=" + debug.playInfoPinned
    );
    appendCommonDebugLines(lines);
    return lines.join("\n");
  }
  function buildDebugText() {
    if (IS_LIVE_PAGE) return buildLiveDebugText();
    var lines = [
      "mode=" + (cfg.enabled ? "on" : "off") + "  target=" + cdnTargetLabel()
    ];
    if (autoHost) lines.push("auto-fallback -> " + autoHost); // 静默覆写：独立一行、纯英文，避免跟上面的使用者设定混在一起
    lines.push(
      "cdn=" + (debug.currentCdn || "-"),
      "v=" + (debug.pickVideoHost || "-") + "  a=" + (debug.pickAudioHost || "-"),
      "src=" + (debug.lastSource || "-") + "  rw=" + debug.rewriteCount + "  seg=" + debug.segRewriteCount + "  qn=" + qnText() + "  spd=" + speedText()
    );
    appendCommonDebugLines(lines);
    return lines.join("\n");
  }
  // 疊層兩種頁面共用的尾段：緩衝／卡住計時／回退額度、最後錯誤（距今秒數）、最近 3 筆事件
  function appendCommonDebugLines(lines) {
    var v = getMainVideo(), now = Date.now();
    var st;
    if (IS_LIVE_PAGE || UI.missing) st = stallState.stuckSince != null ? Math.round((now - stallState.stuckSince) / 1000) + "s/" + Math.round((stallState.limit || 8000) / 1000) + "s" + (UI.missing ? " legacy" : "") : "-";
    else { var es = e1Stats(now); st = es.n + "x/" + (es.ms / 1000).toFixed(1) + "s" + (e1.ep ? (e1.ep.estAt ? " stuck" : " pend") : "") + (BLACK.base ? " black=" + Math.max(0, Math.round((now - BLACK.base) / 1000)) + "s" : ""); }
    var cool = Math.max(0, FALLBACK.coolUntil - now);
    var e2s = IS_LIVE_PAGE ? "" : "  cont=" + (e2.contSince != null ? Math.round((now - e2.contSince) / 1000) + "s" : "-") + (e2.locked ? " lock" : "") + (e2.standby ? " sb=" + shortHost(e2.standby.host) : "");
    lines.push("buf=" + (v ? forwardBufferSec(v).toFixed(1) + "s" : "-") + "  rs=" + (v ? v.readyState : "-") + (v && v.paused ? " paused" : "") +
      "  stall=" + st + e2s + "  failed=" + failedHosts().length + (FALLBACK.noMore ? " nomore" : "") + (FALLBACK.exhausted ? " exh" : "") + (cool > 0 ? " cool=" + Math.round(cool / 1000) + "s" : "") +
      "  lat=" + (debug.lastSegMs ? debug.lastSegMs + "ms" : "-"));
    if (debug.lastError) lines.push("err=" + debug.lastError + (debug.lastErrorAt ? " (" + Math.round((now - debug.lastErrorAt) / 1000) + "s ago)" : ""));
    for (var i = 0; i < recentEvents.length; i++) lines.push("-" + Math.round((now - recentEvents[i].t) / 1000) + "s  " + recentEvents[i].s);
  }
  function renderOverlay() {
    if (window.top !== window) return;
    var player = getPlayerEl();
    // 只在点播观看页（与直播间）显示：首页、影片清单的 hover 预览也有播放器，不要在那里冒出来
    var onWatch = IS_LIVE_PAGE || WATCH_RE.test(location.pathname);
    if (!cfg.showDebug || !player || !onWatch) { if (overlayEl) overlayEl.style.display = "none"; return; }
    if (!overlayEl) {
      if (!document.documentElement) return;
      overlayEl = document.createElement("div");
      overlayEl.id = "bcs-debug-overlay";
      overlayEl.style.cssText = [
        "position:absolute", "top:8px", "left:8px", "z-index:100",
        "font:12px/1.5 Consolas,Menlo,monospace", "color:#7CFC7C",
        "background:rgba(0,0,0,.72)", "padding:6px 9px", "border-radius:6px",
        "white-space:pre", "pointer-events:none", "max-width:70%", "text-shadow:0 1px 2px #000"
      ].join(";");
    }
    if (overlayEl.parentElement !== player) player.appendChild(overlayEl);
    try { if (getComputedStyle(player).position === "static") player.style.position = "relative"; } catch (e) {}
    overlayEl.style.display = "block";
    overlayEl.textContent = buildDebugText();
  }

  function postDebug() {
    try {
      window.postMessage({ __cdnSwitcher: 1, dir: "debug", payload: {
        currentCdn: debug.currentCdn, pickVideoHost: debug.pickVideoHost, pickAudioHost: debug.pickAudioHost,
        lastSource: debug.lastSource, rewriteCount: debug.rewriteCount, segRewriteCount: debug.segRewriteCount,
        lastQn: currentQn(), enabled: cfg.enabled, cdnHost: cfg.cdnHost, cdnTarget: cdnTargetLabel(), autoHost: autoHost, lastError: debug.lastError,
        speedBps: debug.speedBps, speedIdle: debug.speedIdle, live: liveSnapshot(),
        diag: diagSnapshot()
      } }, "*");
    } catch (e) {}
  }
  // 問題回報用的補充狀態（popup 的 debug 區不顯示，回報頁組快照用）
  function diagSnapshot() {
    var v = getMainVideo(), now = Date.now();
    return {
      page: pageInfo(), spaNav: debug.spaNav,
      effective: effHost(), playurlGiven: debug.playurlGiven, backups: backupHosts.slice(0, 8),
      buf: v ? Math.round(forwardBufferSec(v) * 10) / 10 : null, rs: v ? v.readyState : null, paused: v ? v.paused : null, ct: v ? Math.round(v.currentTime) : null,
      stallSince: stallState.stuckSince, stallLimit: stallState.limit || null, e1: IS_LIVE_PAGE ? null : e1Stats(now), stuck: UI.stuck || null, uiMissing: UI.missing ? 1 : 0,
      fb: { coolLeft: Math.max(0, FALLBACK.coolUntil - now), failed: failedHosts(), noMore: FALLBACK.noMore, exhausted: FALLBACK.exhausted, manualPause: FALLBACK.manualPause,
        e2: { cont: e2.contSince != null ? now - e2.contSince : null, locked: e2.locked, standby: e2.standby ? e2.standby.host : null }, testing: R ? R.src : 0, noIntervene: NO_INTERVENE ? 1 : 0 },
      lastErrorAt: debug.lastErrorAt || null, lastSegMs: debug.lastSegMs || null, lastSegReqAgo: lastSegReqAt ? now - lastSegReqAt : null, lastSampleAgo: lastSampleAt ? now - lastSampleAt : null,
      hookAt: debug.hookAt, playurlBeforeHook: debug.playurlBeforeHook, autoFallback: cfg.autoFallback, active: ACTIVE, dash: Object.keys(videoQnByPath).length > 0
    };
  }
  // 每 10 秒一列的採樣（只在有媒體資料時）：回報頁用它看「慢是漸變還是突變」
  function postSample() {
    var v = getMainVideo();
    if (!v || v.readyState === 0 || window.top !== window) return;
    try {
      window.postMessage({ __cdnSwitcher: 1, dir: "sample", payload: {
        t: Date.now(), spd: Math.round(debug.speedBps), idle: debug.speedIdle ? 1 : 0, buf: Math.round(forwardBufferSec(v) * 10) / 10, qn: currentQn(),
        rs: v.readyState, paused: v.paused ? 1 : 0, host: shortHost(debug.currentCdn), lat: debug.lastSegMs || 0
      } }, "*");
    } catch (e) {}
  }
  // 主 video 元素的播放事件（play / pause / seeking / ended / waiting）：player.reload() 會換元素，每個新元素掛一次
  var trackedVideo = null;
  function trackVideoEvents() {
    var v = getMainVideo();
    if (!v || v === trackedVideo) return;
    trackedVideo = v;
    health.bufPause = false;
    e2Break(); // 换了 video 元素（player.reload 之类）：连续播放重新算
    if (v.readyState === 0) rs0EventAt = Date.now();
    // 跳转幅度＝跳转后的 currentTime 减跳转前最近一次记到的 currentTime。大于 1 秒算使用者操作（点留言里的时间连结、
    // 番剧自动跳过片头等清单外的跳转）；播放器卡住时自己往前小跳 0.5 秒也会 seeking，所以门槛 1 秒。
    // 每次载入（loadstart）后、currentTime 还没开始前进之前的第一次跳转不算（续播到上次的位置、播放器重载后跳回原位置）
    var knownCt = v.currentTime || 0, loadSeekPending = true, loadCt = v.currentTime || 0;
    v.addEventListener("timeupdate", function () {
      if (getMainVideo() !== v || v.seeking) return;
      if (loadSeekPending && v.currentTime > loadCt + 0.05) loadSeekPending = false;
      knownCt = v.currentTime;
    });
    v.addEventListener("seeking", function () {
      if (getMainVideo() !== v) return;
      var jump = Math.abs(v.currentTime - knownCt);
      if (loadSeekPending) { loadSeekPending = false; if (jump > 1) jlog("ui.op", { k: "seek", load: 1 }); }
      else if (jump > 1 && Date.now() >= selfSeekUntil) noteUserOp("seek"); // 自己 playerReload 后跳回原位置的不算
      knownCt = v.currentTime;
    });
    v.addEventListener("loadstart", function () { if (getMainVideo() !== v) return; loadSeekPending = true; loadCt = v.currentTime || 0; knownCt = loadCt; });
    ["emptied", "loadstart"].forEach(function (ev) { v.addEventListener(ev, function () { if (getMainVideo() === v) rs0EventAt = Date.now(); }); });
    // 连续播放（入口二）：暂停、等资料、跳转都归零；跳转后「缓冲不到 3 秒」也重新算
    ["pause", "waiting", "seeking", "emptied", "loadstart"].forEach(function (ev) { v.addEventListener(ev, function () { if (getMainVideo() === v) e2Break(); }); });
    v.addEventListener("seeking", function () { if (getMainVideo() === v) e2.lowSince = null; });
    // 暂停当下前方几乎没缓冲 → 缓冲暂停（播放器自己按的）；一播放、换来源就清掉
    v.addEventListener("pause", function () { if (getMainVideo() === v) health.bufPause = !v.ended && hasPlayed(v) && forwardBufferSec(v) < 0.5; });
    ["play", "emptied", "loadstart"].forEach(function (ev) {
      v.addEventListener(ev, function () { if (getMainVideo() === v) health.bufPause = false; });
    });
    ["play", "pause", "seeking", "ended", "waiting"].forEach(function (ev) {
      v.addEventListener(ev, function () { if (getMainVideo() === v) jlog("play.state", { ev: ev, ct: Math.round(v.currentTime) }); });
    });
  }
  var lastHref = location.href, tick = 0, prevErr = null, prevStuck = null;
  function diagTick() {
    tick++;
    if (location.href !== lastHref) { lastHref = location.href; debug.spaNav++; swapLogged = false; jlog("page.nav", pageInfo()); }
    if (debug.lastError !== prevErr) { prevErr = debug.lastError; debug.lastErrorAt = Date.now(); }
    var stuck = IS_LIVE_PAGE || UI.missing ? stallState.stuckSince : null; // 点播的卡顿日志在 onStuckAppear／endEp
    if (stuck != null && prevStuck == null) { var sv = getMainVideo(); jlog("fb.stall", { phase: "start", rs: sv ? sv.readyState : -1, paused: sv ? sv.paused : "", buf: sv ? forwardBufferSec(sv).toFixed(1) : "" }); }
    else if (stuck == null && prevStuck != null && !stallState.hit) jlog("fb.stall", { phase: "clear", after: Math.round((Date.now() - prevStuck) / 1000) + "s" });
    stallState.hit = false;
    prevStuck = stuck;
    trackVideoEvents();
    if (tick % 10 === 0) postSample();
  }
  jlog("page.nav", pageInfo());

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderOverlay);
  else renderOverlay();
  var tickTimer = setInterval(function () { checkVideoKey(); onPipChange(); updateSpeed(); trackVideoEvents(); rescueTick(); diagTick(); renderOverlay(); postDebug(); }, 1000);
  // 分页切回前景：正卡着的那次从现在重新算、入口二重新等连续播放 30 秒（背景期间的状态不算），安装后第一支影片的优化补排一次（见 tabHidden）
  function onVisibility() {
    var hidden = tabHidden();
    jlog("page.vis", { hidden: hidden ? 1 : 0, pip: inPip() ? 1 : 0 });
    if (hidden) { abortAutoTestHidden(); return; }
    var now = Date.now();
    legacyReset();
    holdTimers(now);
    noteLift();
    lastTickAt = now; // 背景期间计时器被节流，下一秒不要当成「取样中断」再把排除期重算一次
    e2.contSince = null; e2.lowSince = null; e2.lastCt = -1;
    maybeScheduleAutoTest();
  }
  try { document.addEventListener("visibilitychange", onVisibility); } catch (e) {}
  // 进出子母画面不会触发 visibilitychange：同样当成切到背景／回到前景（重复呼叫只是多一次重置，无害）
  var lastPip = false;
  function onPipChange() { var p = inPip(); if (p === lastPip) return; lastPip = p; onVisibility(); }
  try {
    ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"].forEach(function (ev) { document.addEventListener(ev, onPipChange, true); });
    if (window.documentPictureInPicture) window.documentPictureInPicture.addEventListener("enter", function (e) {
      onPipChange();
      try { e.window.addEventListener("pagehide", function () { setTimeout(onPipChange, 0); }); } catch (_) {}
    });
  } catch (e) {}

  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") {
    globalThis.__BCS_TEST__.register("main-hook", {
      cfg: function () { return cfg; }, debug: debug, isActive: isActive, effHost: effHost, isHostMode: isHostMode,
      isExpiredUrl: isExpiredUrl, isSegUrl: isSegUrl, isSwappableSeg: isSwappableSeg, swapSegHost: swapSegHost, replaceHost: replaceHost, hostOf: hostOf,
      isFailureStatus: isFailureStatus, shouldFallbackOnStatus: shouldFallbackOnStatus,
      backupHosts: function () { return backupHosts; }, FALLBACK: FALLBACK,
      applyTrack: applyTrack, rewriteContainer: rewriteContainer, rewriteRoot: rewriteRoot, tryRewriteText: tryRewriteText,
      noteBackupHost: noteBackupHost, setPendingBackupHosts: function (v) { pendingBackupHosts = v; }, getPendingBackupHosts: function () { return pendingBackupHosts; },
      liveInfo: liveInfo, liveHostFor: liveHostFor, parseM3u8: parseM3u8, FlvParser: FlvParser, isAvTag: isAvTag,
      playInfoExpires: playInfoExpires, usablePlayInfo: usablePlayInfo, playInfoKey: playInfoKey,
      clampNum: clampNum, cleanTitle: cleanTitle, pageTypeOf: pageTypeOf, qnText: qnText, currentQn: currentQn, isAllowedCdnHost: isAllowedCdnHost,
      addSample: addSample, updateSpeed: updateSpeed, videoQnByPath: function () { return videoQnByPath; },
      needsOwnSig: needsOwnSig, knownUrlOn: knownUrlOn, onSegFailure: onSegFailure, stallState: stallState, legacyCheckStall: legacyCheckStall,
      autoHost: function () { return autoHost; }, checkVideoKey: checkVideoKey, playerVideoKey: playerVideoKey, applyRescuePick: applyRescuePick, mainVideoIdle: mainVideoIdle, noteEarlySample: noteEarlySample, runAutoSpeedTest: runAutoSpeedTest,
      runSpeedTest: runSpeedTest, health: health,
      isFailed: isFailed, markFailed: markFailed, failedHosts: failedHosts, testUrlFor: testUrlFor, listCands: listCands,
      currentBitrateBps: currentBitrateBps, measureHost: measureHost, trackVideoEvents: trackVideoEvents, noteSegment: noteSegment,
      lastSegReqAt: function () { return lastSegReqAt; }, setLastSegReqAt: function (t) { lastSegReqAt = t; }, setLastSegFailAt: function (t) { lastSegFailAt = t; },
      noteSegReq: noteSegReq, setLastSampleAt: function (t) { lastSampleAt = t; },
      // 卡顿救援 v2
      rescueTick: rescueTick, rescueBlocked: rescueBlocked, rescue1: rescue1, e1: e1, e2: e2, BLACK: BLACK, UI: UI, e1Stats: e1Stats,
      uiStuckKind: uiStuckKind, uiSample: uiSample, noteUserOp: noteUserOp, excludeStart: excludeStart, userOps: function () { return userOps; },
      startRound: startRound, round: function () { return R; }, abortRescue: abortRescue, standbyOk: standbyOk,
      term: function () { return term; }, showTerminal: showTerminal, termChoose: termChoose, closeTerminal: closeTerminal, termTick: termTick,
      segFailAt: function () { return segFailAt; }, setSegFailAt: function (t) { segFailAt = t; }, nearEndE2: nearEndE2, bufSec: bufSec,
      noIntervene: function () { return NO_INTERVENE; }, mediaKey: function () { return mediaKey; },
      setLastTickAt: function (t) { lastTickAt = t; },
      stopTick: function () { clearInterval(tickTimer); } // 測試自己呼叫 rescueTick，不要每秒的 interval 在背後亂跑
    });
  }
})();
