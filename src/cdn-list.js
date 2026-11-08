// 節點清單（各國建議節點、全部節點、池類型、其他地區）：由伺服器下發，擴充不打包。background、popup 共用。
//   來源：兩個互相獨立的靜態網站放同一份檔案，先問主要的，失敗（連不上、格式不對、驗章失敗）才問備援。
//     <來源>/cdn-list/latest.json → { v, file }（快取 60 秒）
//     <來源>/<file>（cdn-list/v/<v>.jws，內容永遠不變）→ compact JWS（ES256），
//       payload = { typ: "cdn-list", v, iat（秒）, data: { countries, options, pools } }
//   清單由 scripts/cdn-list.mjs 發布時在本機簽章（私鑰同 /v1/features 的 FEATURES_SIGNING_KEY，kid f1），伺服器只放檔案。
// 本地快取：storage.local.cdnList = { v, jws } 只存簽章原文，每次讀都重新驗章、檢查網域白名單（不符合就整份不用）；
//   storage.local.cdnListMeta = { v, defaultHost, checkedAt }：給 bridge.js 判斷「有沒有清單」與全域預設節點（OTHER 的第一個），
//   以及 6 小時內不再發請求。
// 拿過清單以後：超過 CHECK_MS 才抓版本檔；版本沒變就只記下檢查時間，不下載、不動本地快取。
// 沒有清單＝擴充不啟用（bridge.js 推給頁面的 enabled 是 false），popup 蓋遮罩、background 每分鐘重試。
var BBCdnList = (function () {
  var SOURCES = ["https://static.biboost.app/", "https://dv1itfovv5waq.cloudfront.net/"];
  var LATEST = "cdn-list/latest.json";
  // kid → 公鑰（P-256），同 features.js。換金鑰時先在這裡加新的 kid、發版，再換發布用的私鑰
  var PUBLIC_KEYS = {
    f1: { kty: "EC", crv: "P-256", x: "UQMcBk_Bck5s3VFGPLBnNBnEg_dzz6q0Pm2k3RKcN0I", y: "YPwo2Nlyf1gp1vRwzYt3UjQ2iyjN1zoY7gkISL1MWt0" }
  };
  var STORE_KEY = "cdnList";
  var META_KEY = "cdnListMeta";
  var CHECK_MS = 6 * 60 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 15000;
  // 清單裡的節點只能是 B 站實際使用的網域（同 main-hook.js 的 CDN_HOST_RE）；"backup" 是特殊值（B 站原生備援 URL）。
  // 清單決定影片要改寫到哪個網域：就算簽章私鑰外流，也只能指到這些網域
  var HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:bilivideo\.com|bilivideo\.cn|akamaized\.net|hdslb\.com)$/;
  var CODE_RE = /^[A-Z]{2,8}$/;
  var FALLBACK = "OTHER";

  function b64urlBytes(s) {
    var bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }
  var keyCache = {};
  function importKey(jwk) {
    var id = jwk.x + "." + jwk.y;
    keyCache[id] = keyCache[id] || crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return keyCache[id];
  }
  function verifyJws(jws) {
    return Promise.resolve().then(function () {
      var parts = typeof jws === "string" ? jws.split(".") : [];
      if (parts.length !== 3) return null;
      var header = b64urlJson(parts[0]);
      var jwk = header && header.alg === "ES256" && Object.prototype.hasOwnProperty.call(PUBLIC_KEYS, header.kid) ? PUBLIC_KEYS[header.kid] : null;
      if (!jwk) return null;
      var sig = b64urlBytes(parts[2]);
      if (sig.length !== 64) return null;
      return importKey(jwk).then(function (key) {
        return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(parts[0] + "." + parts[1]));
      }).then(function (ok) { return ok ? b64urlJson(parts[1]) : null; });
    }).catch(function () { return null; });
  }

  function isHost(h) { return typeof h === "string" && h.length <= 253 && HOST_RE.test(h); }
  // 清單內容的檢查（發布腳本 scripts/cdn-list.mjs 也用這個）→ 錯誤訊息陣列，空的＝通過
  function validate(data) {
    var errs = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) return ["清單不是物件"];
    var options = data.options, countries = data.countries;
    if (!Array.isArray(options) || !options.length) errs.push("options 是空的");
    if (!Array.isArray(countries) || !countries.length) errs.push("countries 是空的");
    if (errs.length) return errs;
    if (data.pools != null && (typeof data.pools !== "object" || Array.isArray(data.pools))) errs.push("pools 不是物件");
    var known = {};
    options.forEach(function (o, i) {
      if (!o || typeof o.value !== "string") { errs.push("options[" + i + "] 沒有 value"); return; }
      if (o.value !== "backup" && !isHost(o.value)) errs.push("options[" + i + "] 的網域不在白名單：" + o.value);
      if (known[o.value]) errs.push("options 重複：" + o.value);
      known[o.value] = true;
    });
    var codes = {};
    countries.forEach(function (c, i) {
      if (!c || !CODE_RE.test(c.code || "")) { errs.push("countries[" + i + "] 的 code 不對"); return; }
      if (codes[c.code]) errs.push("countries 重複：" + c.code);
      codes[c.code] = true;
      if (c.dial != null && typeof c.dial !== "number") errs.push(c.code + " 的 dial 不是數字");
      if (!c.name || typeof c.name !== "object") errs.push(c.code + " 沒有 name");
      if (!Array.isArray(c.nodes) || !c.nodes.length) { errs.push(c.code + " 沒有節點"); return; }
      c.nodes.forEach(function (h) {
        if (!isHost(h)) errs.push(c.code + " 的節點網域不在白名單：" + h);
        else if (!known[h]) errs.push(c.code + " 的節點不在 options：" + h);
      });
    });
    if (!codes[FALLBACK]) errs.push("缺少 " + FALLBACK + "（其他地區，第一個節點＝全域預設）");
    return errs;
  }
  function defaultHost(data) {
    var c = (data.countries || []).filter(function (x) { return x.code === FALLBACK; })[0];
    return c ? c.nodes[0] : "";
  }
  // 驗章＋格式＋白名單 → payload 或 null
  function check(jws, expectV) {
    return verifyJws(jws).then(function (p) {
      if (!p || p.typ !== "cdn-list" || typeof p.v !== "number" || (expectV != null && p.v !== expectV)) return null;
      return validate(p.data).length ? null : p;
    });
  }

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, function (s) { r(s || {}); }); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, function () { r(); }); }); }

  // 本地快取（重新驗章）→ { v, data } 或 null
  var memo = null; // { jws, value }：同一份簽章不重複驗
  function load() {
    return get(STORE_KEY).then(function (s) {
      var c = s[STORE_KEY];
      if (!c || typeof c.jws !== "string") return null;
      if (memo && memo.jws === c.jws) return memo.value;
      return check(c.jws, c.v).then(function (p) {
        var value = p ? { v: p.v, data: p.data } : null;
        memo = { jws: c.jws, value: value };
        return value;
      });
    });
  }

  function fetchWithTimeout(url, parse) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(url, { credentials: "omit", cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return parse(r); })
      .then(function (x) { if (timer) clearTimeout(timer); return x; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  // 問一個來源：curV＝本地版本（沒有＝0）→ { same: true } / { v, jws, data } ；失敗 throw
  function askSource(base, curV) {
    return fetchWithTimeout(base + LATEST, function (r) { return r.json(); }).then(function (latest) {
      var v = latest && latest.v;
      if (typeof v !== "number" || typeof latest.file !== "string" || !/^cdn-list\/v\/\d+\.jws$/.test(latest.file)) throw new Error("bad latest");
      if (v <= curV) return { same: true };
      return fetchWithTimeout(base + latest.file, function (r) { return r.text(); }).then(function (jws) {
        jws = jws.trim();
        return check(jws, v).then(function (p) {
          if (!p) throw new Error("bad list");
          return { v: v, jws: jws, data: p.data };
        });
      });
    });
  }

  var inflight = null;
  // 檢查有沒有新版本。force：不管上次什麼時候檢查過都問（安裝、重試、按「重試」）
  // → { ok: 有沒有清單可用, changed: 這次換了新清單, data }
  function refresh(force) {
    if (inflight) return inflight;
    inflight = Promise.all([load(), get(META_KEY)]).then(function (arr) {
      var cur = arr[0], meta = arr[1][META_KEY];
      var now = Date.now();
      if (cur && !force && meta && meta.v === cur.v && now - (meta.checkedAt || 0) < CHECK_MS && now >= (meta.checkedAt || 0)) {
        return { ok: true, changed: false, data: cur.data };
      }
      var curV = cur ? cur.v : 0;
      var i = 0;
      function next() {
        if (i >= SOURCES.length) {
          if (!cur) return { ok: false, changed: false, data: null };
          // 兩邊都連不上但手上有清單：30 分鐘後再試，不要每開一個 B 站頁面就問一次
          var b = {}; b[META_KEY] = { v: cur.v, defaultHost: defaultHost(cur.data), checkedAt: now - CHECK_MS + 30 * 60 * 1000 };
          return set(b).then(function () { return { ok: true, changed: false, data: cur.data, failed: true }; });
        }
        var base = SOURCES[i++];
        return askSource(base, curV).then(function (res) {
          if (res.same) {
            var o = {}; o[META_KEY] = { v: cur.v, defaultHost: defaultHost(cur.data), checkedAt: now };
            return set(o).then(function () { return { ok: true, changed: false, data: cur.data }; });
          }
          var o2 = {};
          o2[STORE_KEY] = { v: res.v, jws: res.jws };
          o2[META_KEY] = { v: res.v, defaultHost: defaultHost(res.data), checkedAt: now };
          memo = { jws: res.jws, value: { v: res.v, data: res.data } };
          return set(o2).then(function () { return { ok: true, changed: true, data: res.data }; });
        }).catch(next);
      }
      return next();
    }).then(function (r) { inflight = null; return r; }, function () { inflight = null; return { ok: false, changed: false, data: null }; });
    return inflight;
  }

  // 某國要列／要測的節點（不含 backup），只留 options 裡有的
  function countryHosts(data, code) {
    var known = {};
    (data.options || []).forEach(function (o) { if (o.value !== "backup") known[o.value] = true; });
    var c = (data.countries || []).filter(function (x) { return x.code === code; })[0];
    return c ? c.nodes.filter(function (h) { return !!known[h]; }) : [];
  }

  var api = {
    load: load, refresh: refresh, validate: validate, verifyJws: verifyJws, check: check, defaultHost: defaultHost, countryHosts: countryHosts, isHost: isHost,
    SOURCES: SOURCES, PUBLIC_KEYS: PUBLIC_KEYS, STORE_KEY: STORE_KEY, META_KEY: META_KEY, CHECK_MS: CHECK_MS, FALLBACK: FALLBACK
  };
  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("cdn-list", api);
  return api;
})();
