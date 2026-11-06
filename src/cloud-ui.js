// 雲端備份的視窗（popup、歡迎頁、登入回跳頁共用）。資料與 API 在 cloud.js（BBCloud），文字用 common.js 的 t()。
//   BBCloudUI.open()           蓋在整頁上的視窗（右上角 ✕、點外面關掉）；成功時播打勾動畫，約 1.5 秒後自己關掉
//   BBCloudUI.mount(el, opts)  直接畫在某個元素裡（登入回跳頁用，沒有關閉鈕）
// 狀態：
//   未登入：說明＋「使用 Google 登入」（開新分頁；登入完成後 storage 變動，視窗自己換成已登入）
//   已登入：email、「備份到雲端」「從雲端同步到本地」、上次備份的時間與來源、自動同步開關、最下面小字「登出」
var BBCloudUI = (function () {
  var STYLE_ID = "bbCloudStyle";
  var CSS = [
    ".bbcMask{position:fixed;inset:0;z-index:150;display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}",
    ".bbcCard{position:relative;width:100%;max-width:360px;box-sizing:border-box;padding:16px 16px 12px;border-radius:12px;background:var(--raised,#fff);color:var(--text,#18191c);box-shadow:0 8px 28px rgba(0,0,0,.35);text-align:center}",
    ".bbcClose{position:absolute;top:6px;right:8px;border:0;background:none;font-size:16px;line-height:1;padding:6px;cursor:pointer;color:var(--muted,#61666d)}",
    ".bbcTitle{font-size:15px;font-weight:600;margin:0 0 8px}",
    ".bbcText{font-size:12.5px;line-height:1.6;color:var(--muted,#61666d);margin:0 0 12px;text-align:left}",
    ".bbcEmail{font-size:12.5px;color:var(--muted,#61666d);margin:0 0 12px;word-break:break-all}",
    ".bbcBtns{display:flex;flex-direction:column;gap:8px}",
    ".bbcBtn{display:flex;flex-direction:column;align-items:center;gap:1px;width:100%;padding:9px 12px;border:0;border-radius:8px;background:var(--accent,#fb7299);color:var(--accent-text,#fff);font:inherit;font-weight:600;cursor:pointer;box-sizing:border-box}",
    ".bbcBtn small{font-weight:400;font-size:11.5px;opacity:.85}",
    ".bbcBtn.alt{background:var(--control-bg,#fff);color:inherit;border:1px solid var(--border,#e3e5e7)}",
    ".bbcBtn:disabled{opacity:.6;cursor:default}",
    ".bbcBtn.google{flex-direction:row;justify-content:center;gap:8px;background:var(--control-bg,#fff);color:inherit;border:1px solid var(--border,#e3e5e7)}",
    ".bbcMeta{font-size:12px;color:var(--muted,#61666d);margin:10px 0 0}",
    ".bbcAuto{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--border,#e3e5e7);text-align:left;font-size:13px}",
    ".bbcAuto small{display:block;color:var(--muted,#61666d);font-size:11.5px;line-height:1.5;margin-top:2px}",
    ".bbcAuto input{width:18px;height:18px;flex:none;accent-color:var(--accent,#fb7299)}",
    ".bbcErr{font-size:12.5px;color:var(--danger,#d93025);margin:10px 0 0}",
    ".bbcLogout{margin-top:12px;border:0;background:none;padding:0;font:inherit;font-size:11.5px;color:var(--muted,#61666d);text-decoration:underline;cursor:pointer}",
    ".bbcDone{padding:14px 0 6px}",
    ".bbcDone svg{width:64px;height:64px;display:block;margin:0 auto 8px}",
    ".bbcDone circle{fill:none;stroke:#2ba471;stroke-width:4;stroke-dasharray:166;stroke-dashoffset:166;animation:bbcStroke .5s ease-out forwards}",
    ".bbcDone path{fill:none;stroke:#2ba471;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:48;stroke-dashoffset:48;animation:bbcStroke .35s .45s ease-out forwards}",
    ".bbcDone .bbcTitle{animation:bbcPop .4s .6s both}",
    "@keyframes bbcStroke{to{stroke-dashoffset:0}}",
    "@keyframes bbcPop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
    "@media (prefers-reduced-motion:reduce){.bbcDone circle,.bbcDone path,.bbcDone .bbcTitle{animation:none;stroke-dashoffset:0}}"
  ].join("\n");
  var GOOGLE_SVG = '<svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>';
  var DONE_SVG = '<svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25"/><path d="M16 29l8 8 16-17"/></svg>';
  var DONE_MS = 1500;

  function style() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function errText(e) {
    var code = (e && (e.code || e.message)) || "error";
    if (code === "network") return t("cloudErrNetwork");
    if (code === "no_backup") return t("cloudErrNoBackup");
    if (code === "unauthorized" || code === "not_logged_in") return t("cloudErrLogin");
    if (code === "not_found") return t("cloudErrUnavailable");
    return t("cloudErrGeneric").replace("{code}", code);
  }
  function timeText(ms) {
    try { return new Date(ms).toLocaleString(uiLanguage(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  // card：畫內容的元素；onDone：成功動畫播完後呼叫（視窗用來關掉自己）
  function panel(card, onDone) {
    var alive = true, busy = false;
    function clear() { card.querySelectorAll(":scope > :not(.bbcClose)").forEach(function (n) { n.remove(); }); }
    function render() {
      if (!alive) return;
      BBCloud.status().then(function (st) {
        if (!alive || busy) return;
        clear();
        card.appendChild(el("div", "bbcTitle", t("cloudTitle")));
        if (!st.account) return renderLogin();
        renderAccount(st);
      });
    }
    function renderLogin(err) {
      card.appendChild(el("p", "bbcText", t("cloudLoginHint")));
      var btns = el("div", "bbcBtns"), b = el("button", "bbcBtn google");
      b.type = "button";
      b.insertAdjacentHTML("beforeend", GOOGLE_SVG);
      b.appendChild(el("span", "", t("cloudLoginGoogle")));
      b.addEventListener("click", function () {
        b.disabled = true;
        BBCloud.startLogin().then(function () {
          var hint = card.querySelector(".bbcMeta") || card.appendChild(el("p", "bbcMeta"));
          hint.textContent = t("cloudLoginOpened");
          b.disabled = false;
        }, function (e) { b.disabled = false; showErr(e); });
      });
      btns.appendChild(b);
      card.appendChild(btns);
      if (err) showErr(err);
    }
    function renderAccount(st) {
      card.appendChild(el("p", "bbcEmail", t("cloudSignedInAs").replace("{email}", st.account.email || "—")));
      var btns = el("div", "bbcBtns");
      var up = actionBtn("bbcBtn", t("cloudBackupBtn"), t("cloudBackupHint"), function () { return BBCloud.backup(); }, t("cloudBackupDone"));
      var down = actionBtn("bbcBtn alt", t("cloudRestoreBtn"), t("cloudRestoreHint"), function () { return BBCloud.restore(); }, t("cloudRestoreDone"));
      btns.appendChild(up);
      btns.appendChild(down);
      card.appendChild(btns);
      var meta = card.appendChild(el("p", "bbcMeta", t("cloudWorking")));
      BBCloud.remoteInfo().then(function (info) {
        if (!alive) return;
        var l = info.last;
        meta.textContent = l ? t("cloudLastBackup").replace("{time}", timeText(l.at)).replace("{by}", t(l.by === "extension" ? "cloudByExt" : l.by ? "cloudByApp" : "cloudByExt")) : t("cloudNoBackup");
      }, function (e) { if (!alive) return; meta.textContent = errText(e); if (e.code === "unauthorized") render(); });
      var auto = el("label", "bbcAuto"), txt = el("span", "", t("cloudAutoLabel")), box = document.createElement("input");
      txt.appendChild(el("small", "", t("cloudAutoHint")));
      box.type = "checkbox";
      box.checked = !!st.sync.auto;
      box.addEventListener("change", function () {
        box.disabled = true;
        // 自動同步在 background 跑（popup 關了也要繼續）
        chrome.runtime.sendMessage({ type: "CDN_SWITCHER_CLOUD_AUTO", on: box.checked }, function (r) {
          void chrome.runtime.lastError;
          box.disabled = false;
          if (r && r.error) { box.checked = !box.checked; showErr({ code: r.error }); }
        });
      });
      auto.appendChild(txt);
      auto.appendChild(box);
      card.appendChild(auto);
      var out = el("button", "bbcLogout", t("cloudLogout"));
      out.type = "button";
      out.addEventListener("click", function () { out.disabled = true; BBCloud.logout().then(render); });
      card.appendChild(out);
    }
    function actionBtn(cls, label, hint, run, doneText) {
      var b = el("button", cls);
      b.type = "button";
      b.appendChild(el("span", "", label));
      b.appendChild(el("small", "", hint));
      b.addEventListener("click", function () {
        if (busy) return;
        busy = true;
        card.querySelectorAll("button,input").forEach(function (x) { x.disabled = true; });
        b.firstChild.textContent = t("cloudWorking");
        run().then(function () { busy = false; done(doneText); }, function (e) {
          busy = false;
          if (e && e.code === "unauthorized") { render(); return; }
          card.querySelectorAll("button,input").forEach(function (x) { x.disabled = false; });
          b.firstChild.textContent = label;
          showErr(e);
        });
      });
      return b;
    }
    function showErr(e) {
      var box = card.querySelector(".bbcErr") || card.appendChild(el("p", "bbcErr"));
      box.textContent = errText(e);
    }
    function done(text) {
      clear();
      var d = el("div", "bbcDone");
      d.insertAdjacentHTML("beforeend", DONE_SVG);
      d.appendChild(el("div", "bbcTitle", text));
      card.appendChild(d);
      setTimeout(function () { if (onDone) onDone(); else render(); }, DONE_MS);
    }
    // 登入／登出（別的分頁）、自動同步狀態變了 → 重畫
    function onChange(ch, area) { if (area === "local" && !busy && (ch.cloudAccount || ch.cloudSync && !card.querySelector(".bbcAuto"))) render(); }
    chrome.storage.onChanged.addListener(onChange);
    render();
    return { destroy: function () { alive = false; try { chrome.storage.onChanged.removeListener(onChange); } catch (e) {} }, render: render };
  }

  function open() {
    style();
    var mask = el("div", "bbcMask"), card = el("div", "bbcCard"), x = el("button", "bbcClose", "✕");
    mask.setAttribute("role", "dialog");
    mask.setAttribute("aria-modal", "true");
    mask.setAttribute("aria-label", t("cloudTitle"));
    x.type = "button";
    x.setAttribute("aria-label", t("cloudClose"));
    card.appendChild(x);
    mask.appendChild(card);
    document.body.appendChild(mask);
    var p;
    function close() { p.destroy(); mask.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    x.addEventListener("click", close);
    mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
    document.addEventListener("keydown", onKey);
    p = panel(card, close);
    return { close: close, element: mask };
  }
  function mount(container) {
    style();
    var card = el("div", "bbcCard");
    container.appendChild(card);
    return panel(card, null);
  }

  var api = { open: open, mount: mount, DONE_MS: DONE_MS };
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("cloud-ui", api);
  return api;
})();
