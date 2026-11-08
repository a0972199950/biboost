// 雲端備份的視窗（popup、歡迎頁、登入回跳頁共用）。資料與 API 在 cloud.js（BBCloud），文字用 common.js 的 t()。
//   BBCloudUI.open()           蓋在整頁上的視窗（右上角 ✕、點外面關掉）；成功時播打勾動畫，約 1.5 秒後自己關掉
//   BBCloudUI.mount(el, opts)  直接畫在某個元素裡（歡迎頁、登入回跳頁），沒有 ✕。opts：
//     fresh：剛安裝（歡迎頁）。
//            未登入：說明＋「使用 Google 登入」「稍後再說」（上下排，稍後再說呼叫 onLater）
//            已登入：「要從雲端恢復設定嗎？」＋主色按鈕「從雲端恢復」＋上次備份時間；雲端沒有備份就只寫「雲端還沒有備份」。
//            沒有「備份到雲端」、自動同步開關（一打開就會拿全新的預設值蓋掉雲端的備份）、取消、登出（登出只在 popup 的視窗）
//     back：登入在同一個視窗換頁，登入完 auth.html 換回這個擴充頁面（歡迎頁）
//     onDone：成功動畫播完後呼叫（關掉視窗）
//     onLater、laterText：fresh 未登入時的「稍後再說」
//     onState(state, card)：每次畫完、雲端有沒有備份確定時、成功動畫開始時呼叫，state = { signedIn, canRestore, done }（歡迎頁用來換「開始使用」的文字、畫鎖頭、恢復成功時收起按鈕）
//     onCancel、cancelText：（非 fresh）多一顆一樣樣式的「關閉」（登入回跳頁用）
// 狀態：
//   未登入：說明＋「使用 Google 登入」（popup 開小視窗；歡迎頁在同一個視窗換頁。登入完成後 storage 變動，視窗自己換成已登入）
//   已登入：email、「備份到雲端」「從雲端恢復設定」（不分主次、滑過變色）、上次備份的時間、自動同步開關、最下面小字「登出」
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
    ".bbcBtns.row{flex-direction:row}",
    ".bbcBtns.row>.bbcBtn{flex:1 1 0;min-width:0}",
    // 所有按鈕同一個樣式（不分主次，使用者要求）：白底灰框，滑過時框與字變成主題色、底色變淡
    ".bbcBtn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;width:100%;padding:9px 12px;border:1px solid var(--border,#e3e5e7);border-radius:8px;background:var(--control-bg,#fff);color:inherit;font:inherit;font-weight:600;cursor:pointer;box-sizing:border-box;transition:background-color .15s,border-color .15s,color .15s}",
    ".bbcBtn small{font-weight:400;font-size:11.5px;color:var(--muted,#61666d);transition:color .15s}",
    ".bbcBtn:hover:not(:disabled),.bbcBtn:focus-visible{border-color:var(--accent,#fb7299);background:var(--hover-bg,#ffecf1);color:var(--accent,#fb7299);outline:none}",
    ".bbcBtn:hover:not(:disabled) small{color:inherit;opacity:.85}",
    ".bbcBtn:disabled{opacity:.5;cursor:default}",
    ".bbcBtn.google{flex-direction:row;gap:8px}",
    // 帶圖標的按鈕（備份到雲端、從雲端恢復設定）：圖標在左、文字靠左；圖標是細線，平常灰色，滑過時跟著變主題色
    ".bbcBtn.withIcon{flex-direction:row;justify-content:flex-start;gap:12px;padding:9px 14px;text-align:left}",
    ".bbcBtn.withIcon .bbcLbl{display:flex;flex-direction:column;gap:1px;min-width:0}",
    ".bbcIcon{flex:none;width:58px;height:25px;color:var(--muted,#61666d);transition:color .15s}",
    ".bbcIcon *{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}",
    ".bbcBtn:hover:not(:disabled) .bbcIcon,.bbcBtn:focus-visible .bbcIcon{color:inherit}",
    // 主色按鈕（歡迎頁的「從雲端恢復」）：圖標跟文字一樣是白色，整組置中
    ".bbcBtn.primary .bbcIcon{color:inherit}",
    ".bbcBtn.withIcon.center{justify-content:center}",
    // 主色按鈕（只有歡迎頁的「從雲端恢復」，使用者要求）
    ".bbcBtn.primary{background:var(--accent,#fb7299);border-color:var(--accent,#fb7299);color:var(--accent-text,#fff)}",
    ".bbcBtn.primary:hover:not(:disabled),.bbcBtn.primary:focus-visible{background:var(--accent-hover,var(--accent,#fb7299));border-color:var(--accent-hover,var(--accent,#fb7299));color:var(--accent-text,#fff);filter:brightness(.95)}",
    ".bbcAsk{font-size:14px;font-weight:600;margin:0 0 12px}",
    ".bbcMeta{font-size:12px;color:var(--muted,#61666d);margin:10px 0 0}",
    ".bbcAuto{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0;padding:10px 0 0;border-top:1px solid var(--border,#e3e5e7);text-align:left;font-size:13px}",
    // 自動同步的勾選框自己畫（瀏覽器內建的在淺色主題是粉底黑勾，使用者覺得醜）：沒勾＝灰框，勾了＝主題色底、白勾
    ".bbcAuto input{-webkit-appearance:none;appearance:none;width:18px;height:18px;flex:none;margin:0;border:1.5px solid var(--border,#c9ccd0);border-radius:4px;background:var(--control-bg,#fff) center/12px 12px no-repeat;cursor:pointer;transition:background-color .15s,border-color .15s}",
    ".bbcAuto input:checked{border-color:var(--accent,#fb7299);background-color:var(--accent,#fb7299);background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-4.9' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")}",
    ".bbcAuto input:focus-visible{outline:2px solid var(--accent,#fb7299);outline-offset:2px}",
    ".bbcAuto input:disabled{opacity:.5;cursor:default}",
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
  // 圖標：電腦 → 箭頭 → 雲（備份）、雲 → 箭頭 → 電腦（恢復）。viewBox 46×20：螢幕 0–14、箭頭 17–28、雲 31–45
  var ICON_MON = '<rect x="1" y="3" width="13" height="9.5" rx="1.8"/><path d="M7.5 12.5v3M4.5 16.5h6"/>';
  var ICON_CLOUD = '<path d="M34.2 15.5h7.6a3.1 3.1 0 0 0 .5-6.15 4.4 4.4 0 0 0-8.45-.9 3.55 3.55 0 0 0 .35 7.05z"/>';
  var ICON_ARROW = '<path d="M18 9.5h9M24.2 6.6 27.1 9.5l-2.9 2.9"/>';
  function iconSvg(inner) { return '<svg class="bbcIcon" viewBox="0 0 46 20" aria-hidden="true">' + inner + "</svg>"; }
  var ICON_UP = iconSvg(ICON_MON + ICON_ARROW + ICON_CLOUD);
  var ICON_DOWN = iconSvg('<g transform="translate(-30 0)">' + ICON_CLOUD + "</g>" + ICON_ARROW + '<g transform="translate(31 0)">' + ICON_MON + "</g>");
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

  // card：畫內容的元素；opts 見最上面（fresh、back、onDone、onCancel、cancelText）
  function panel(card, opts) {
    opts = opts || {};
    var onDone = opts.onDone;
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
    function cancelBtn() {
      var c = el("button", "bbcBtn bbcCancel", opts.cancelText || t("cloudCancel"));
      c.type = "button";
      c.addEventListener("click", function () { if (!busy) opts.onCancel(); });
      return c;
    }
    function renderLogin(err) {
      card.appendChild(el("p", "bbcText", t(opts.fresh ? "cloudWelcomeHint" : "cloudLoginHint")));
      var btns = el("div", "bbcBtns"), b = el("button", "bbcBtn google");
      b.type = "button";
      b.insertAdjacentHTML("beforeend", GOOGLE_SVG);
      b.appendChild(el("span", "", t("cloudLoginGoogle")));
      b.addEventListener("click", function () {
        b.disabled = true;
        BBCloud.startLogin(opts.back ? { back: opts.back } : null).then(function () {
          if (opts.back) return; // 這一頁正在換到 Google
          var hint = card.querySelector(".bbcMeta") || card.appendChild(el("p", "bbcMeta"));
          hint.textContent = t("cloudLoginOpened");
          b.disabled = false;
        }, function (e) { b.disabled = false; showErr(e); });
      });
      btns.appendChild(b);
      if (opts.fresh && opts.onLater) {
        var later = el("button", "bbcBtn bbcLater", opts.laterText || t("cloudLater"));
        later.type = "button";
        later.addEventListener("click", function () { opts.onLater(); });
        btns.appendChild(later);
      } else if (opts.onCancel) btns.appendChild(cancelBtn());
      card.appendChild(btns);
      if (err) showErr(err);
      notify({ signedIn: false, canRestore: false });
    }
    function notify(state) { if (alive && typeof opts.onState === "function") opts.onState(state, card); }
    function lastText(l) { return l ? t("cloudLastBackup").replace("{time}", timeText(l.at)) : t("cloudNoBackup"); }
    // 歡迎頁（剛安裝）登入後：只問要不要從雲端恢復。確定雲端有備份才出現問句與按鈕
    function renderFreshAccount(st) {
      card.appendChild(el("p", "bbcEmail", t("cloudSignedInAs").replace("{email}", st.account.email || "—")));
      var ask = card.appendChild(el("p", "bbcAsk", t("cloudRestoreAsk")));
      var btns = card.appendChild(el("div", "bbcBtns"));
      btns.appendChild(actionBtn(t("cloudRestoreShort"), "", function () { return BBCloud.restore(); }, t("cloudRestoreDone"), "primary center", ICON_DOWN));
      var meta = card.appendChild(el("p", "bbcMeta", t("cloudWorking")));
      ask.hidden = btns.hidden = true;
      notify({ signedIn: true, canRestore: false });
      BBCloud.remoteInfo().then(function (info) {
        if (!alive) return;
        meta.textContent = lastText(info.last);
        ask.hidden = btns.hidden = !info.last;
        notify({ signedIn: true, canRestore: !!info.last });
      }, function (e) { if (!alive) return; meta.textContent = errText(e); if (e.code === "unauthorized") render(); });
    }
    function renderAccount(st) {
      if (opts.fresh) return renderFreshAccount(st);
      card.appendChild(el("p", "bbcEmail", t("cloudSignedInAs").replace("{email}", st.account.email || "—")));
      var btns = el("div", "bbcBtns");
      btns.appendChild(actionBtn(t("cloudBackupBtn"), t("cloudBackupHint"), function () { return BBCloud.backup(); }, t("cloudBackupDone"), "", ICON_UP));
      btns.appendChild(actionBtn(t("cloudRestoreBtn"), t("cloudRestoreHint"), function () { return BBCloud.restore(); }, t("cloudRestoreDone"), "", ICON_DOWN));
      if (opts.onCancel) btns.appendChild(cancelBtn());
      card.appendChild(btns);
      var meta = card.appendChild(el("p", "bbcMeta", t("cloudWorking")));
      BBCloud.remoteInfo().then(function (info) {
        if (!alive) return;
        meta.textContent = lastText(info.last);
      }, function (e) { if (!alive) return; meta.textContent = errText(e); if (e.code === "unauthorized") render(); });
      var auto = el("label", "bbcAuto"), txt = el("span", "", t("cloudAutoLabel")), box = document.createElement("input");
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
      renderLogout();
    }
    function renderLogout() {
      var out = el("button", "bbcLogout", t("cloudLogout"));
      out.type = "button";
      out.addEventListener("click", function () { out.disabled = true; BBCloud.logout().then(render); });
      card.appendChild(out);
    }
    function actionBtn(label, hint, run, doneText, cls, icon) {
      var b = el("button", "bbcBtn" + (cls ? " " + cls : "") + (icon ? " withIcon" : ""));
      b.type = "button";
      var box = b;
      if (icon) { b.insertAdjacentHTML("beforeend", icon); box = b.appendChild(el("span", "bbcLbl")); }
      var name = box.appendChild(el("span", "", label));
      if (hint) box.appendChild(el("small", "", hint));
      b.addEventListener("click", function () {
        if (busy) return;
        busy = true;
        card.querySelectorAll("button,input").forEach(function (x) { x.disabled = true; });
        name.textContent = t("cloudWorking");
        run().then(function () { busy = false; done(doneText); }, function (e) {
          busy = false;
          if (e && e.code === "unauthorized") { render(); return; }
          card.querySelectorAll("button,input").forEach(function (x) { x.disabled = false; });
          name.textContent = label;
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
      notify({ signedIn: true, canRestore: false, done: true });
      clear();
      var d = el("div", "bbcDone");
      d.insertAdjacentHTML("beforeend", DONE_SVG);
      d.appendChild(el("div", "bbcTitle", text));
      card.appendChild(d);
      setTimeout(function () { if (onDone) onDone(); else render(); }, DONE_MS);
    }
    // 登入／登出（別的分頁）、自動同步狀態變了 → 重畫
    // 成功的打勾動畫播放中不重畫（動畫播完會自己關掉或重畫）
    function onChange(ch, area) { if (area === "local" && !busy && !card.querySelector(".bbcDone") && (ch.cloudAccount || ch.cloudSync && !opts.fresh && !card.querySelector(".bbcAuto"))) render(); }
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
    p = panel(card, { onDone: close });
    return { close: close, element: mask };
  }
  function mount(container, opts) {
    style();
    var card = el("div", "bbcCard");
    container.appendChild(card);
    return panel(card, opts);
  }

  var api = { open: open, mount: mount, DONE_MS: DONE_MS };
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("cloud-ui", api);
  return api;
})();
