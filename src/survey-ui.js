/*
 * 問卷的畫面（B 站頁面上的 modal，ISOLATED world 的 content script，和 survey-core.js、survey-page.js 一起載入；
 * 公告開的問卷在擴充的單獨視窗 survey-window.html 裡用同一份畫面，opts.inWindow）。
 * 只負責「依伺服器下發的題目定義畫出來、收答案」；什麼時候出現、答案怎麼送，見 survey-page.js／survey.js（背景），分頁與跳題規則在 survey-core.js。
 *  - 半透明遮罩＋置中的卡片；Shadow DOM 隔開 B 站的 CSS；z-index 蓋過播放器與 B 站的浮層
 *  - 右上角 × 與 Esc 關閉；點遮罩不關閉（避免誤觸）
 *  - 版面與配色照測速 App（只有淺色）：頁首 logo、品牌、問卷標題、說明文字，粉色線、白色內容卡、按鈕列，最下面中間是進度點點、右下角「第幾題/總題數」
 *  - 一題一畫面（inline 的說明框畫在它的上游題目下面；最後連續的輸入框題併成一頁）。題型：單選、複選（可設上限）、短文字、長文字、Email、
 *    評分（1–5）、推薦分數（0–10）、數字、排序。單選、評分、推薦分數第一次作答點了就進下一題，已經有答案時改了要自己按「下一題」
 *  - 選項順序照 opts.order（隨機排序的題目由背景第一次顯示時決定、存在草稿）
 *  - 離開每一頁時回報停留時間（onPage）；關閉時告訴呼叫端是不是使用者按 × 或 Esc（onClose）
 *  - 送出成功：打勾動畫＋「謝謝」約 1.4 秒後自動關。問卷畫面上按 × 或 Esc：立刻 onClose，再顯示「不會再出現、可以從公告找回」8 秒後自動關
 *  - 題目、選項、說明文字全部用 textContent 放（內容來自伺服器，不當成 HTML）
 */
var BBSurveyUI = (function () {
  "use strict";
  var Core = BBSurveyCore;

  // 配色與版面照測速 App（tools/cdn-speedtest-app/app.py 的 C）：灰底、白色內容卡、B 站粉的強調色與頁首下的粉色線；只有淺色模式
  var CSS =
    ":host{all:initial}" +
    // 頁首離畫面上緣：一般 12vh；畫面矮（例如 13 吋筆電的可視區約 800px）時往上縮，讓 7 個選項的頁面不用在卡片裡捲動
    ".ov{--top:clamp(16px,12vh,calc(100vh - 760px));position:fixed;inset:0;box-sizing:border-box;padding-top:var(--top);background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;color-scheme:light;font:15px/1.5 -apple-system,'Segoe UI','Microsoft JhengHei UI','Microsoft JhengHei','PingFang TC','Noto Sans CJK TC',sans-serif;color:#18191c}" +
    ".card{position:relative;box-sizing:border-box;width:min(480px,92vw);max-height:calc(100vh - var(--top) - 16px);display:flex;flex-direction:column;background:#f4f5f7;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.35)}" +
    ".card:focus{outline:none}" +
    ".head{flex:none;position:relative;background:#fff;padding:14px 52px 12px 20px}" +
    ".hrow{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px}" +
    ".logo{flex:none;display:block;width:34px;height:34px;margin-right:-2px}.logo svg{display:block;width:100%;height:100%;overflow:visible}" +
    ".logo .lbody{transform-box:view-box;transform-origin:100px 118px;animation:bbsLean 3s ease-in-out infinite}" +
    ".logo .hand{transform-box:view-box;transform-origin:134px 104px;animation:bbsHand 3s ease-in-out infinite}" +
    "@keyframes bbsLean{0%,14%,80%,100%{transform:rotate(0)}24%,70%{transform:rotate(-5deg)}}" +
    "@keyframes bbsHand{0%,10%{transform:translate(-14px,22px) rotate(30deg);opacity:0}22%{transform:translate(0,0) rotate(0);opacity:1}32%{transform:rotate(-14deg)}42%{transform:rotate(10deg)}52%{transform:rotate(-14deg)}62%{transform:rotate(10deg)}74%{transform:rotate(0);opacity:1}88%,100%{transform:translate(-14px,22px) rotate(30deg);opacity:0}}" +
    "@media (prefers-reduced-motion:reduce){.logo .lbody,.logo .hand{animation:none}.logo .hand{opacity:0}}" +
    ".brand{margin:0;font-size:15px;font-weight:700;line-height:1.3;color:#61666d}" +
    ".title{margin:0;padding-left:10px;border-left:1px solid #e3e5e7;font-size:21px;font-weight:700;line-height:1.3;color:#18191c}" +
    ".prompt{margin:8px 0 0;font-size:14px;color:#61666d}" +
    ".line{flex:none;height:3px;background:#fb7299}" +
    ".x{position:absolute;top:10px;right:12px;width:32px;height:32px;border:0;background:transparent;font-size:22px;line-height:1;color:#61666d;cursor:pointer;border-radius:8px}" +
    ".x:hover{background:#f1f2f3}" +
    ".wrap{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 0}" +
    ".box{box-sizing:border-box;background:#fff;border:1px solid #e3e5e7;border-radius:8px;padding:20px 22px}" +
    ".q{margin:0 0 14px;font-size:17px;font-weight:600;line-height:1.45}" +
    ".opts{display:flex;flex-direction:column;gap:8px}" +
    ".opt{box-sizing:border-box;width:100%;text-align:left;padding:11px 14px;border:1px solid #e3e5e7;border-radius:8px;background:#fff;color:inherit;font:inherit;cursor:pointer;display:flex;gap:10px;align-items:center}" +
    ".opt:hover{border-color:#fb7299;background:#fff7f9}" +
    ".opt.on{border-color:#fb7299;background:#ffecf1}" +
    ".mark{flex:none;width:18px;height:18px;border:1.5px solid #b5b9bf;border-radius:4px;box-sizing:border-box;position:relative;background:#fff}" +
    ".opt.single .mark{border-radius:50%}" +
    ".opt.multi.on .mark{border-color:#2ba471;background:#2ba471}" +
    ".opt.multi.on .mark:after{content:'';position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}" +
    ".opt.single.on .mark{border-color:#fb7299}" +
    ".opt.single.on .mark:after{content:'';position:absolute;left:3px;top:3px;width:9px;height:9px;border-radius:50%;background:#fb7299}" +
    ".field{margin:0 0 12px}" +
    ".field label{display:block;margin:0 0 6px;font-size:14px;font-weight:600}" +
    ".field.inline{margin:12px 0 0}.field.inline textarea{min-height:56px}[hidden]{display:none!important}" +
    "input[type=email],textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid #e3e5e7;border-radius:6px;font:inherit;color:inherit;background:#fff}" +
    "textarea{min-height:84px;resize:vertical}" +
    "input[type=email]:focus,textarea:focus{outline:0;border-color:#fb7299}" +
    ".box input.bad,.box input.bad:focus{border-color:#d93025}.box .hint.bad{color:#d93025}.field .err{margin:6px 0 0}" +
    ".consent{display:flex;gap:8px;align-items:flex-start;margin:4px 0 0;font-size:13px;color:#61666d}" +
    ".consent input{accent-color:#2ba471}" +
    ".slot{flex:none}" +
    ".foot{display:flex;justify-content:space-between;gap:10px;padding:12px 16px 0}" +
    ".btn{padding:8px 18px;border-radius:6px;border:1px solid #e3e5e7;background:#fff;color:inherit;font:inherit;cursor:pointer}" +
    ".btn:hover{background:#f1f2f3}" +
    ".btn.pri{border-color:#fb7299;background:#fb7299;color:#fff;font-weight:600;margin-left:auto}" +
    ".btn.pri:hover{border-color:#e85c86;background:#e85c86}" +
    ".btn[disabled],.btn[disabled]:hover{border-color:#f5c2d1;background:#f5c2d1;cursor:default}" +
    ".btn:not(.pri)[disabled]{opacity:.45;background:#fff;border-color:#e3e5e7}" +
    ".err{margin:10px 0 0;font-size:13px;color:#d93025}" +
    ".prog{flex:none;position:relative;display:flex;justify-content:center;align-items:center;gap:6px;min-height:20px;padding:12px 16px 14px}" +
    ".dot{width:14px;height:5px;border-radius:3px;background:#e3e5e7}" +
    ".dot.on{background:#fb7299}.dot.cur{width:28px}" +
    ".count{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:13px;color:#fb7299;font-variant-numeric:tabular-nums}" +
    ".done{text-align:center;padding:16px 8px 8px}.done h2{margin:0 0 14px;font-size:20px}" +
    ".done .btn.pri{margin-left:0}" +
    // 關掉問卷後的提示（沒有按鈕，8 秒後自動關）
    ".done .msg{margin:0;padding:0 0 8px;font-size:16px;line-height:1.6;color:#18191c;text-wrap:balance}" +
    // 送出成功：粉色圓圈畫出來→填滿→白色打勾畫出來→輕輕彈一下，「謝謝」淡入；播完自動關（淡出）
    ".done.ok{padding:8px 8px 4px}.done.ok h2{margin:0;opacity:0;animation:bbsFadeIn .3s .35s ease-out forwards}" +
    ".okmark{display:block;width:64px;height:64px;margin:0 auto 12px;overflow:visible;animation:bbsPop .3s .7s ease-out}" +
    ".okmark .ring{fill:#fb7299;fill-opacity:0;stroke:#fb7299;stroke-width:3;stroke-dasharray:151;stroke-dashoffset:151;animation:bbsDraw .45s ease-out forwards,bbsFill .25s .35s ease-out forwards}" +
    ".okmark .tick{fill:none;stroke:#fff;stroke-width:4.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:34;stroke-dashoffset:34;animation:bbsDraw .3s .5s ease-out forwards}" +
    "@keyframes bbsDraw{to{stroke-dashoffset:0}}@keyframes bbsFill{to{fill-opacity:1}}@keyframes bbsFadeIn{to{opacity:1}}" +
    "@keyframes bbsPop{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}" +
    ".ov{transition:opacity .25s ease-in}.ov.out{opacity:0}" +
    // 減少動態：直接顯示打勾與文字，不淡出（一樣自動關）
    "@media (prefers-reduced-motion:reduce){.okmark,.okmark .ring,.okmark .tick,.done.ok h2{animation:none}.okmark .ring{stroke-dashoffset:0;fill-opacity:1}.okmark .tick{stroke-dashoffset:0}.done.ok h2{opacity:1}.ov{transition:none}}" +
    ".opt[disabled],.opt[disabled]:hover{opacity:.45;cursor:default;border-color:#e3e5e7;background:#fff}" +
    "input[type=text],input[type=number]{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid #e3e5e7;border-radius:6px;font:inherit;color:inherit;background:#fff}" +
    "input[type=text]:focus,input[type=number]:focus{outline:0;border-color:#fb7299}input.bad{border-color:#d93025}" +
    ".numrow{display:flex;align-items:center;gap:10px}.numrow input{max-width:180px}.unit{color:#61666d}.hint{margin:6px 0 0;font-size:12px;color:#9499a0}" +
    ".scale{display:flex;flex-wrap:wrap;gap:6px}.scale.nps{gap:4px}" +
    ".sc{flex:1 0 40px;min-width:40px;height:40px;border:1px solid #e3e5e7;border-radius:8px;background:#fff;color:inherit;font:inherit;cursor:pointer}" +
    ".scale.nps .sc{flex:1 0 32px;min-width:32px;padding:0}.sc:hover{border-color:#fb7299}.sc.on{border-color:#fb7299;background:#ffecf1;font-weight:700;color:#e85c86}" +
    ".scale.stars{gap:2px}.star{border:0;background:none;padding:0 3px;font-size:32px;line-height:1;color:#d5d8dc;cursor:pointer}.star.on{color:#ffb400}.star:hover{color:#ffcf5c}" +
    ".ends{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:12px;color:#61666d}" +
    ".rank{display:flex;flex-direction:column;gap:6px}.ritem{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e3e5e7;border-radius:8px;background:#fff;cursor:grab}" +
    ".ritem.drag{opacity:.5}.rnum{flex:none;width:18px;color:#fb7299;font-weight:700;text-align:center}.rtext{flex:1}" +
    ".rbtn{flex:none;width:30px;height:30px;border:1px solid #e3e5e7;border-radius:6px;background:#fff;color:#61666d;font:inherit;cursor:pointer}.rbtn[disabled]{opacity:.35;cursor:default}" +
    ".pad{height:14px}" +
    // 在擴充的單獨視窗裡（公告開的問卷，survey-window.html）：沒有遮罩，卡片填滿視窗（視窗本身就是框）
    ".ov.win{padding-top:0;background:transparent}.ov.win .card{width:100%;max-height:100vh;border-radius:0;box-shadow:none}";

  // 頁首的 logo：擴充圖示（同 scripts/gen-icons.mjs、welcome-hero.js 的畫法）＋頂端兩角一雙眼睛。
  // 動畫「舉手發問」（使用者 2026-11-18 從 10 種裡挑的第 7 種）：身體微傾，右後方舉起一隻小手揮兩下再放下，每輪 3 秒
  var LOGO_INK = "#3a1424";
  var LOGO_HAND = '<g class="hand"><path d="M128 104 Q140 92 146 70" stroke="rgb(235,90,140)" stroke-width="6" stroke-linecap="round" fill="none"/>' +
    '<circle cx="147" cy="64" r="8" fill="#fff" stroke="rgb(235,90,140)" stroke-width="2.4"/></g>';
  var LOGO_SVG = '<svg viewBox="56 26 88 94" aria-hidden="true">' +
    '<defs><linearGradient id="bbsLogoBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="rgb(255,138,176)"/><stop offset="100%" stop-color="rgb(235,90,140)"/></linearGradient></defs>' +
    '<g class="lbody">' + LOGO_HAND + '<g transform="translate(64,46) scale(0.140625)"><rect width="512" height="512" rx="112" ry="112" fill="url(#bbsLogoBg)"/>' +
    ["92,140 320,140 320,82 420,166 320,250 320,192 92,192", "420,320 192,320 192,262 92,346 192,430 192,372 420,372"].map(function (p) {
      return '<polygon transform="translate(0,9)" points="' + p + '" fill="rgb(120,20,55)" fill-opacity="0.18"/><polygon points="' + p + '" fill="white"/>';
    }).join("") + "</g>" +
    [72, 128].map(function (x) {
      return '<g transform="translate(' + x + ',43)"><circle r="12" fill="rgb(250,120,165)" stroke="rgb(235,90,140)" stroke-width="1.6"/>' +
        '<circle r="8.4" fill="#fff"/><circle r="4.4" fill="' + LOGO_INK + '"/><circle cx="1.5" cy="-1.6" r="1.4" fill="#fff"/></g>';
    }).join("") + "</g></svg>";

  // 送出成功的動畫播多久就自動關（最後 FADE_MS 淡出）；按 × 或 Esc 關掉問卷後的提示停留多久
  var SUCCESS_MS = 1400, CLOSED_NOTICE_MS = 8000, FADE_MS = 250;
  var OK_SVG = '<svg class="okmark" viewBox="0 0 52 52" aria-hidden="true"><circle class="ring" cx="26" cy="26" r="24"/><path class="tick" d="M15 27 L22.5 34.5 L37.5 18.5"/></svg>';
  // 還停在「關掉後的提示」或成功動畫的上一份畫面：再打開一份時先收掉，不疊兩層（例如提示還沒消失就從公告打開問卷）
  var lingering = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, text, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // opts：{ def, answers, order: { <題目 id>: [選項 id…] }, lang, ui:{…（closedNotice：關掉後的提示）}, promptText, showConsent,
  //         onAnswer(answers)→Promise, onSubmit(answers,{telemetryConsent})→Promise<{ok}>, onPage({ page, question, ms }), onClose({ byUser, page }),
  //         ended（只顯示「問卷已經結束」一句話）, inWindow（擴充的單獨視窗：不畫遮罩、卡片填滿）,
  //         onGone()（畫面整個收掉的那一刻：成功動畫、關掉後的提示、「已經結束」都結束之後；視窗版用它關視窗）}
  function open(opts) {
    if (lingering) lingering();
    var def = opts.def, lang = opts.lang, ui = opts.ui || {};
    var answers = {};
    Object.keys(opts.answers || {}).forEach(function (k) { answers[k] = opts.answers[k]; });
    var pageKey = null; // 目前頁面的第一題 id
    var pageStart = 0; // 進到這一頁的時間（停留時間用）
    var mode = "survey"; // survey｜notice（問卷已經結束）｜success（送出成功的動畫）｜closed（按 × 或 Esc 關掉問卷後的提示）
    var consentChecked = false;
    var closed = false, reported = false;
    var timers = [];

    var host = document.createElement("div");
    host.setAttribute("data-bb-survey", "1");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647";
    var root = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    var ov = el("div", "ov" + (opts.inWindow ? " win" : ""));
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    var card = el("div", "card");
    card.tabIndex = -1;
    ov.appendChild(card);
    root.appendChild(ov);

    // 輸入框裡打字不要觸發 B 站的快捷鍵（事件穿過 Shadow DOM 時目標會變成 host，B 站分辨不出是輸入框）
    ["keydown", "keyup", "keypress"].forEach(function (ev) { host.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(true); } }
    window.addEventListener("keydown", onKey, true);

    // byUser：按 × 或 Esc。問卷畫面上按的才算「關掉」（成功動畫、問卷已經結束、關掉後的提示上按不算）。
    // 問卷畫面上按的：立刻呼叫 onClose 記下關掉（不等提示消失，免得使用者這幾秒內換頁就沒記到），畫面換成「不會再出現、可以從公告找回」的提示，
    // 8 秒後自動關，或按 × ／ Esc 關；提示關掉時不再呼叫 onClose。onClose 一份問卷只呼叫一次
    function close(byUser) {
      if (closed) return;
      if (byUser && mode === "survey") {
        var info = { byUser: true, page: currentPageNumber() };
        leavePage();
        report(info);
        closedNotice();
        return;
      }
      var info2 = { byUser: false, page: currentPageNumber() };
      if (mode === "survey") leavePage();
      teardown();
      report(info2);
    }
    function report(info) {
      if (reported) return;
      reported = true;
      if (opts.onClose) opts.onClose(info);
    }
    function teardown() {
      closed = true;
      timers.forEach(function (t) { clearTimeout(t); });
      timers = [];
      if (lingering === dismiss) lingering = null;
      window.removeEventListener("keydown", onKey, true);
      host.remove();
      if (opts.onGone) { try { opts.onGone(); } catch (e) {} }
    }
    function dismiss() { close(false); }
    // ms 後自動關（最後 FADE_MS 淡出）；換畫面時先清掉上一個畫面的計時
    function autoClose(ms) {
      timers.forEach(function (t) { clearTimeout(t); });
      timers = [
        setTimeout(function () { ov.classList.add("out"); }, Math.max(0, ms - FADE_MS)),
        setTimeout(function () { close(false); }, ms)
      ];
    }

    // 版面（同測速 App）：頁首（品牌、說明文字、×）＋粉色線＋白色內容卡（box）＋按鈕列（slot）＋最下面的進度
    var box = null, slot = null, prog = null;
    // after：問卷結束後的畫面（成功動畫、關掉後的提示）不再畫邀請的說明文字
    function layout(withProgress, after) {
      card.textContent = "";
      var head = el("div", "head");
      // 第一行：logo、產品名、問卷標題（標題由伺服器下發，沒有就不畫）
      var row = el("div", "hrow");
      var logo = el("span", "logo");
      logo.innerHTML = LOGO_SVG; // 固定的 SVG 字串（不含伺服器內容）
      row.appendChild(logo);
      row.appendChild(el("p", "brand", ui.brand || "BiBoost"));
      var title = Core.pick(def.title, lang);
      if (title) row.appendChild(el("p", "title", title));
      head.appendChild(row);
      if (opts.promptText && !after) head.appendChild(el("p", "prompt", opts.promptText));
      var x = button("x", "×", function () { close(true); });
      x.setAttribute("aria-label", ui.close || "Close");
      head.appendChild(x);
      card.appendChild(head);
      card.appendChild(el("div", "line"));
      var wrap = el("div", "wrap");
      box = el("div", "box");
      wrap.appendChild(box);
      card.appendChild(wrap);
      slot = el("div", "slot");
      card.appendChild(slot);
      prog = el("div", "prog");
      card.appendChild(prog);
      if (withProgress) drawProgress();
    }
    // 進度：中間是點點（答過的與目前這題是粉色，目前這題比較長），右下角「第幾題/總題數」。
    // 跳題是流程圖：總題數是依目前答案實際會走到的頁數（最後併在一起的選填題算一頁），改答案換了一條路時會跟著變
    function drawProgress() {
      if (!prog) return;
      prog.textContent = "";
      var pages = Core.pagesOf(def, answers), idx = Math.max(0, pageIndex(pages, pageKey));
      pages.forEach(function (p, i) { prog.appendChild(el("i", "dot" + (i <= idx ? " on" : "") + (i === idx ? " cur" : ""))); });
      prog.appendChild(el("span", "count", (idx + 1) + "/" + pages.length));
    }

    function pageIndex(pages, key) {
      for (var i = 0; i < pages.length; i++) if (pages[i][0].id === key) return i;
      return -1;
    }
    function currentPageNumber() { return Math.max(0, pageIndex(Core.pagesOf(def, answers), pageKey)) + 1; }
    function isLastPage() { var pages = Core.pagesOf(def, answers); return pageIndex(pages, pageKey) === pages.length - 1; }
    // 離開一頁（下一題、上一題、送出、關掉）：回報第幾頁、哪一題、停留多久
    function leavePage() {
      if (!pageKey || !pageStart) return;
      var info = { page: currentPageNumber(), question: pageKey, ms: Math.max(0, Date.now() - pageStart) };
      pageStart = 0;
      if (opts.onPage) { try { opts.onPage(info); } catch (e) {} }
    }

    // 接著填（草稿）：停在「最後一頁有答案的頁面」的下一頁（略過的選填題不會把人拉回去）；沒有答案就從第一頁開始
    function firstPageKey() {
      var pages = Core.pagesOf(def, answers), furthest = -1;
      pages.forEach(function (p, i) { if (p.some(function (q) { return Core.hasAnswer(answers[q.id]); })) furthest = i; });
      if (!pages.length) return null;
      return pages[Math.min(furthest + 1, pages.length - 1)][0].id;
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    // 回頭改答案、走到另一條路後，不在目前路徑上的題目（原本那條路、收起來的說明框）的答案一併丟掉，不送出
    function prune() {
      var keep = Core.pathIds(def, answers);
      Object.keys(answers).forEach(function (k) { if (keep.indexOf(k) < 0) delete answers[k]; });
    }
    function persist() { prune(); return opts.onAnswer ? Promise.resolve(opts.onAnswer(clone(answers))).catch(function () {}) : Promise.resolve(); }

    function goNext() {
      var pages = Core.pagesOf(def, answers), i = pageIndex(pages, pageKey);
      if (i >= 0 && i + 1 < pages.length) { leavePage(); pageKey = pages[i + 1][0].id; render(); }
      else finish(null, null);
    }
    // 上一題＝目前路徑上的前一頁。路徑完全由前面幾題的答案決定，所以就是實際走過來的那條路（接著填草稿、直接停在後面的頁面時也能往回）
    function goPrev() {
      var pages = Core.pagesOf(def, answers), i = pageIndex(pages, pageKey);
      if (i > 0) { leavePage(); pageKey = pages[i - 1][0].id; render(); }
    }

    // 選項的顯示順序：背景在第一次顯示時決定好（隨機排序的題目），存在草稿裡；對不上就用原順序
    function ordered(q) {
      var opts2 = q.options || [], want = opts.order && opts.order[q.id];
      if (!Array.isArray(want) || want.length !== opts2.length) return opts2;
      var byId = {};
      opts2.forEach(function (o) { byId[o.id] = o; });
      var out = want.map(function (id) { return byId[id]; });
      return out.every(Boolean) ? out : opts2;
    }

    // 每一頁的按鈕列：上一題（第一頁不能按）＋下一題／送出（最後一頁）。canNext()：現在能不能按下一題
    function footer(canNext, onNext) {
      var foot = el("div", "foot");
      var back = button("btn", ui.prev || "Back", goPrev);
      back.disabled = pageIndex(Core.pagesOf(def, answers), pageKey) <= 0;
      foot.appendChild(back);
      var next = button("btn pri", "", onNext || function () { persist(); goNext(); });
      function refresh() {
        next.textContent = isLastPage() ? (ui.submit || "Submit") : (ui.next || "Next");
        next.disabled = !canNext();
      }
      refresh();
      foot.appendChild(next);
      slot.appendChild(foot);
      return { next: next, refresh: refresh };
    }

    function render() {
      var pages = Core.pagesOf(def, answers), i = pageIndex(pages, pageKey);
      if (i < 0) { if (!pages.length) return finish(null, null); pageKey = pages[0][0].id; i = 0; }
      var page = pages[i];
      mode = "survey";
      layout(true);
      pageStart = Date.now();
      var q = page[0];
      if (page.length === 1 && (q.type === "single" || q.type === "multi")) renderChoice(q);
      else if (page.length === 1 && (q.type === "rating" || q.type === "nps")) renderScale(q);
      else if (page.length === 1 && q.type === "number") renderNumber(q);
      else if (page.length === 1 && q.type === "rank") renderRank(q);
      else renderFields(page);
    }

    // ---- 單選、複選（可設最多選幾個；選了「其他」出現說明框）----
    function renderChoice(q) {
      box.appendChild(el("p", "q", Core.pick(q.text, lang)));
      var list = el("div", "opts");
      var multi = q.type === "multi";
      var fresh = !Core.hasAnswer(answers[q.id]); // 進到這一題時還沒有答案：單選題點了就自動進下一題
      var btns = [];
      ordered(q).forEach(function (o) {
        var b = button("opt " + (multi ? "multi" : "single") + (Core.asArray(answers[q.id]).indexOf(o.id) >= 0 ? " on" : ""));
        b.appendChild(el("span", "mark"));
        b.appendChild(el("span", "", Core.pick(o.text, lang)));
        b.addEventListener("click", function () {
          if (multi) {
            var set = Core.asArray(answers[q.id]).slice(), at = set.indexOf(o.id);
            if (at >= 0) set.splice(at, 1); else set.push(o.id);
            answers[q.id] = set;
            b.classList.toggle("on", at < 0);
            limitSelection();
            nav.refresh();
            drawProgress(); // 這題的出口可能跟著答案變（走另一條路），總題數要重算
            refreshInline(true);
          } else {
            answers[q.id] = o.id;
            persist();
            // 第一次作答就直接進下一題；但選到會打開說明框的選項（例如「其他」）時留在這頁讓人填
            if (fresh && !refreshInline(true)) return goNext();
            // 已經有答案：只換選取，等使用者按「下一題」
            btns.forEach(function (x) { x.classList.toggle("on", x === b); });
            nav.refresh();
            drawProgress();
          }
        });
        b._optId = o.id;
        btns.push(b);
        list.appendChild(b);
      });
      box.appendChild(list);
      // 複選上限：選滿時其他選項不能按
      function limitSelection() {
        if (!multi || !q.maxSelect) return;
        var full = Core.asArray(answers[q.id]).length >= q.maxSelect;
        btns.forEach(function (b) { b.disabled = full && !b.classList.contains("on"); });
      }
      limitSelection();
      // 附在這一題下面的說明框（inline 而且 showIf 指到這一題，例如選了「其他」才出現的選填說明），選到對應選項才顯示
      var inlineBoxes = Core.inlineOf(def, q.id).map(function (iq) {
        var f = el("div", "field inline");
        f.appendChild(el("label", "", Core.pick(iq.text, lang))); // 「（選填）」在伺服器下發的文字裡
        var inp = document.createElement("textarea");
        inp.rows = 2;
        inp.maxLength = iq.maxLength || Core.LIMITS.inline;
        inp.value = answers[iq.id] || "";
        inp.addEventListener("input", function () { answers[iq.id] = inp.value; });
        f.appendChild(inp);
        box.appendChild(f);
        return { q: iq, el: f, inp: inp };
      });
      // 依目前答案顯示／收起說明框；回傳現在有沒有任何說明框開著。focus：剛打開的放上游標
      function refreshInline(focus) {
        var any = false;
        inlineBoxes.forEach(function (x) {
          var show = Core.isVisible(x.q, answers), opening = show && x.el.hidden;
          x.el.hidden = !show;
          if (show) {
            any = true;
            if (x.inp.value) answers[x.q.id] = x.inp.value; // 收起時被 prune 丟掉的說明，再打開時接回來
            if (opening && focus) { try { x.inp.focus({ preventScroll: true }); } catch (e) {} }
          }
        });
        return any;
      }
      inlineBoxes.forEach(function (x) { x.el.hidden = true; });
      refreshInline(false);
      var nav = footer(function () { return !(q.required && !Core.asArray(answers[q.id]).length); });
    }

    // ---- 評分（1–5，星星或數字）、推薦分數（0–10）----
    function renderScale(q) {
      box.appendChild(el("p", "q", Core.pick(q.text, lang)));
      var nps = q.type === "nps", stars = !nps && !(q.scale && q.scale.style === "number");
      var lo = nps ? 0 : 1, hi = nps ? 10 : 5;
      var fresh = !Core.hasAnswer(answers[q.id]);
      var row = el("div", "scale" + (nps ? " nps" : "") + (stars ? " stars" : "")), btns = [];
      function paint() {
        var v = answers[q.id];
        btns.forEach(function (b) { b.classList.toggle("on", stars ? (typeof v === "number" && b._v <= v) : b._v === v); });
      }
      for (var n = lo; n <= hi; n++) {
        (function (v) {
          var b = button(stars ? "star" : "sc", stars ? "★" : String(v), function () {
            answers[q.id] = v;
            persist();
            if (fresh) return goNext();
            paint();
            nav.refresh();
          });
          b.setAttribute("aria-label", String(v));
          b._v = v;
          btns.push(b);
          row.appendChild(b);
        })(n);
      }
      box.appendChild(row);
      var labels = nps ? q.labels : q.scale && q.scale.labels;
      if (labels && (labels.low || labels.high)) {
        var ends = el("div", "ends");
        ends.appendChild(el("span", "", Core.pick(labels.low, lang)));
        ends.appendChild(el("span", "", Core.pick(labels.high, lang)));
        box.appendChild(ends);
      }
      paint();
      var nav = footer(function () { return !(q.required && typeof answers[q.id] !== "number"); });
    }

    // ---- 數字（範圍、間隔、單位）----
    function renderNumber(q) {
      box.appendChild(el("p", "q", Core.pick(q.text, lang)));
      var r = q.range || {};
      var line = el("div", "numrow");
      var inp = document.createElement("input");
      inp.type = "number";
      inp.inputMode = "decimal";
      if (typeof r.min === "number") inp.min = String(r.min);
      if (typeof r.max === "number") inp.max = String(r.max);
      inp.step = r.step ? String(r.step) : "any";
      if (typeof answers[q.id] === "number") inp.value = String(answers[q.id]);
      line.appendChild(inp);
      if (r.unit) line.appendChild(el("span", "unit", Core.pick(r.unit, lang)));
      box.appendChild(line);
      var hint = el("p", "hint", (r.min != null ? r.min : "") + " – " + (r.max != null ? r.max : ""));
      box.appendChild(hint);
      function valid(v) {
        if (typeof v !== "number" || !isFinite(v) || v < r.min || v > r.max) return false;
        if (r.step) { var k = (v - r.min) / r.step; if (Math.abs(k - Math.round(k)) > 1e-9) return false; }
        return true;
      }
      inp.addEventListener("input", function () {
        var raw = inp.value.trim(), v = raw === "" ? null : Number(raw);
        if (v != null && valid(v)) answers[q.id] = v; else delete answers[q.id];
        var bad = raw !== "" && !(v != null && valid(v));
        inp.classList.toggle("bad", bad);
        hint.classList.toggle("bad", bad); // 超出範圍：輸入框和範圍提示都變紅，看得出為什麼不能按下一題
        nav.refresh();
      });
      var nav = footer(function () {
        var raw = inp.value.trim();
        if (raw === "") return !q.required;
        return valid(Number(raw));
      });
    }

    // ---- 排序（拖曳；手機與鍵盤用上移／下移）。作答＝目前的順序 ----
    function renderRank(q) {
      box.appendChild(el("p", "q", Core.pick(q.text, lang)));
      var opts2 = ordered(q), byId = {};
      opts2.forEach(function (o) { byId[o.id] = o; });
      var cur = Array.isArray(answers[q.id]) && answers[q.id].length === opts2.length && answers[q.id].every(function (id) { return byId[id]; })
        ? answers[q.id].slice() : opts2.map(function (o) { return o.id; });
      var list = el("div", "rank"), dragFrom = -1;
      function move(i, j) {
        if (j < 0 || j >= cur.length || i === j) return;
        var x = cur.splice(i, 1)[0];
        cur.splice(j, 0, x);
        answers[q.id] = cur.slice();
        draw(j);
      }
      function draw(focusAt) {
        list.textContent = "";
        cur.forEach(function (id, i) {
          var item = el("div", "ritem");
          item.draggable = true;
          item.appendChild(el("span", "rnum", String(i + 1)));
          item.appendChild(el("span", "rtext", Core.pick(byId[id].text, lang)));
          var up = button("rbtn", "↑", function () { move(i, i - 1); });
          up.setAttribute("aria-label", ui.moveUp || "Move up");
          up.disabled = i === 0;
          var down = button("rbtn", "↓", function () { move(i, i + 1); });
          down.setAttribute("aria-label", ui.moveDown || "Move down");
          down.disabled = i === cur.length - 1;
          item.appendChild(up);
          item.appendChild(down);
          item.addEventListener("dragstart", function (e) { dragFrom = i; item.classList.add("drag"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); } catch (er) {} });
          item.addEventListener("dragend", function () { item.classList.remove("drag"); });
          item.addEventListener("dragover", function (e) { e.preventDefault(); });
          item.addEventListener("drop", function (e) { e.preventDefault(); if (dragFrom >= 0) move(dragFrom, i); dragFrom = -1; });
          list.appendChild(item);
          if (focusAt === i) { try { (i === 0 ? down : up).focus({ preventScroll: true }); } catch (er) {} }
        });
      }
      draw(-1);
      box.appendChild(list);
      footer(function () { return true; }, function () { answers[q.id] = cur.slice(); persist(); goNext(); });
    }

    // ---- 輸入框（短文字、長文字、Email）：中間的單獨一頁，或最後併在一起的一頁（＋Firefox 的匿名統計勾選、送出）----
    function renderFields(page) {
      var last = isLastPage();
      var emailFields = [];
      page.forEach(function (q) {
        var f = el("div", "field");
        f.appendChild(el("label", "", Core.pick(q.text, lang))); // 「（選填）」已經在伺服器下發的題目文字裡
        var inp;
        if (q.type === "email") { inp = document.createElement("input"); inp.type = "email"; inp.autocomplete = "email"; inp.maxLength = Core.LIMITS.email; inp.placeholder = "name@example.com"; }
        else if (q.type === "text") { inp = document.createElement("input"); inp.type = "text"; inp.maxLength = q.maxLength || Core.LIMITS.text; }
        else { inp = document.createElement("textarea"); inp.maxLength = q.maxLength || Core.LIMITS.longtext; }
        inp.value = answers[q.id] || "";
        inp.addEventListener("input", function () { answers[q.id] = inp.value; inp.classList.remove("bad"); if (hint) hint.style.display = "none"; refresh(); });
        f.appendChild(inp);
        // Email 格式不對：按下一題／送出時才提示（打字中不打擾）
        var hint = null;
        if (q.type === "email") { hint = el("p", "err", ui.badEmail || "Please check the email address."); hint.style.display = "none"; f.appendChild(hint); emailFields.push({ q: q, inp: inp, hint: hint }); }
        box.appendChild(f);
      });
      if (last && opts.showConsent && ui.consent) {
        var row = el("label", "consent");
        var consent = document.createElement("input");
        consent.type = "checkbox";
        consent.checked = consentChecked;
        consent.addEventListener("change", function () { consentChecked = consent.checked; });
        row.appendChild(consent);
        row.appendChild(el("span", "", ui.consent));
        box.appendChild(row);
      }
      var err = el("p", "err");
      err.style.display = "none";
      box.appendChild(err);
      function missing() { return page.some(function (q) { return q.required && !Core.hasAnswer(answers[q.id]); }); }
      function tidy() { page.forEach(function (q) { if (!Core.hasAnswer(answers[q.id])) delete answers[q.id]; else answers[q.id] = String(answers[q.id]).trim(); }); }
      // 填了但格式不對的 Email：標紅、顯示提示、游標移過去；回傳 true 表示要擋下
      function badEmail() {
        var bad = emailFields.filter(function (x) { return Core.hasAnswer(answers[x.q.id]) && !Core.isEmail(answers[x.q.id]); });
        bad.forEach(function (x) { x.inp.classList.add("bad"); x.hint.style.display = ""; });
        if (bad.length) bad[0].inp.focus();
        return bad.length > 0;
      }
      var nav = footer(function () { return !missing(); }, function () {
        if (badEmail()) return;
        tidy();
        if (!last) { persist(); return goNext(); }
        nav.next.disabled = true; err.style.display = "none";
        finish(nav.next, err);
      });
      // 最後一頁：都沒填（而且都是選填）時寫「略過並送出」
      function refresh() {
        nav.refresh();
        if (last) nav.next.textContent = page.some(function (q) { return Core.hasAnswer(answers[q.id]); }) || page.some(function (q) { return q.required; }) ? (ui.submit || "Submit") : (ui.skipSubmit || "Skip and submit");
      }
      refresh();
    }

    // 送出（最後一題答完或最後一頁按送出）。失敗：顯示錯誤，按鈕可以再按
    function finish(btn, err) {
      prune();
      leavePage();
      Promise.resolve(opts.onSubmit(clone(answers), { telemetryConsent: consentChecked })).then(function (r) {
        if (r && r.ok) return success();
        if (btn) btn.disabled = false;
        if (err) { err.textContent = ui.fail || "Failed. Please try again later."; err.style.display = ""; return; }
        // 最後一題是自動跳的單選（沒有送出按鈕）：留在這頁、加一顆重送
        pageStart = Date.now();
        var e2 = el("p", "err", ui.fail || "Failed. Please try again later.");
        box.appendChild(e2);
        var retry = button("btn pri", ui.submit || "Submit", function () { retry.disabled = true; finish(retry, e2); });
        slot.textContent = "";
        var foot = el("div", "foot"); foot.appendChild(retry); slot.appendChild(foot);
      }, function () { if (btn) btn.disabled = false; });
    }

    // 提示畫面共用的版面：沒有進度點點（拿掉點點那一列的空間，白框下面留一般的邊距）
    function plain(cls, after) {
      layout(false, after);
      var d = el("div", cls);
      box.appendChild(d);
      prog.style.display = "none";
      box.parentNode.style.paddingBottom = "16px";
      return d;
    }
    // 只顯示一句話＋「關閉」：問卷已經結束
    function notice(text) {
      mode = "notice";
      var d = plain("done");
      d.appendChild(el("h2", "", text));
      d.appendChild(button("btn pri", ui.close || "Close", function () { close(false); }));
    }
    // 送出成功：打勾動畫＋「謝謝」，播完（SUCCESS_MS）自動關，沒有關閉按鈕（右上 ×、Esc 照樣能關）
    function success() {
      mode = "success";
      var d = plain("done ok", true);
      d.setAttribute("role", "status");
      var mark = el("span", "");
      mark.innerHTML = OK_SVG; // 固定的 SVG 字串（不含伺服器內容）
      d.appendChild(mark.firstChild);
      d.appendChild(el("h2", "", ui.thanks || "Thank you"));
      lingering = dismiss;
      autoClose(SUCCESS_MS);
    }
    // 按 × 或 Esc 關掉問卷後：告訴使用者不會再出現、可以從公告找回；CLOSED_NOTICE_MS 後自動關
    function closedNotice() {
      mode = "closed";
      var d = plain("done", true);
      d.setAttribute("role", "status");
      d.appendChild(el("p", "msg", ui.closedNotice || "This survey won't show up again. If you change your mind, you can find it in the announcements."));
      lingering = dismiss;
      autoClose(CLOSED_NOTICE_MS);
      try { card.focus({ preventScroll: true }); } catch (e) {}
    }

    (document.documentElement || document.body).appendChild(host);
    if (opts.ended) notice(ui.ended || "This survey has ended. Thank you!");
    else { pageKey = firstPageKey(); render(); }
    try { card.focus({ preventScroll: true }); } catch (e) {}
    return { close: close, host: host, root: root };
  }

  var api = { open: open, pick: Core.pick, pagesOf: Core.pagesOf, isVisible: Core.isVisible, CSS: CSS, SUCCESS_MS: SUCCESS_MS, CLOSED_NOTICE_MS: CLOSED_NOTICE_MS };
  globalThis.BBSurveyUI = api; // 後台的預覽頁用 import 載入（模組裡的 var 不會變成全域）
  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("survey-ui", api);
  return api;
})();
