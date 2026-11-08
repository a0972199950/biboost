// 歡迎頁的開場動畫：擴充圖示（跟 scripts/gen-icons.mjs 同一份畫法，不改）＋頂端兩角一雙眼睛（跟 popup 道歉動畫同一種長法）。
// 10 種風格給使用者挑（使用者要求），挑定後只留那一種。
//   BBWelcomeHero.render(el, n)  在 el 裡畫第 n 種（1–10）
//   BBWelcomeHero.VARIANTS       [{ name, desc }]（預覽頁用）
// 結構：svg > 背景小物 > 影子 > .a1 > .a2 > .a3（三層可以各自動，transform 才不會互相蓋掉）> 圖示＋眼睛 > 前景小物
// 眼睛：.open（白眼珠＋.pupil 黑眼珠，眨眼＝scaleY）、.happy（笑瞇瞇 ^）、.shut（緊閉 > <），用 opacity 切換
var BBWelcomeHero = (function () {
  var STYLE_ID = "bbWelcomeHeroStyle";
  var INK = "#3a1424";
  var CSS = [
    ".wh{display:block;width:220px;height:165px;margin:0 auto;overflow:visible}",
    ".wh .a1,.wh .a2,.wh .a3{transform-box:view-box;transform-origin:100px 118px}",
    ".wh .open,.wh .happy,.wh .shut,.wh .shadow,.wh .fx{transform-box:fill-box;transform-origin:center}",
    ".wh .happy,.wh .shut{opacity:0}",
    ".wh .shadow{fill:rgba(0,0,0,.12)}",
    ".wh .ground{fill:var(--border,#e3e5e7)}",
    ".wh .fx{opacity:0}",
    "@keyframes whPop{0%{transform:scale(0)}100%{transform:scale(1)}}",
    "@keyframes whFadeIn{from{opacity:0}to{opacity:1}}",
    "@keyframes whFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
    "@keyframes whShadowFloat{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.88);opacity:.8}}",
    "@keyframes whBlink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}",
    "@keyframes whBlink2{0%,7%,14%,100%{transform:scaleY(1)}3.5%,10.5%{transform:scaleY(.1)}}",

    // 1 彈出眨眼
    ".wh1 .a1{animation:whPop .7s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh1 .a2{animation:whFloat 3s ease-in-out .9s infinite}",
    ".wh1 .shadow{animation:whPop .7s cubic-bezier(.34,1.56,.64,1) both,whShadowFloat 3s ease-in-out .9s infinite}",
    ".wh1 .open{animation:whBlink2 4s .8s infinite}",

    // 2 探頭：先只露出眼睛，左看右看，跳出來笑
    ".wh2 .a1{animation:whPeek 2.8s ease-out both}",
    "@keyframes whPeek{0%{transform:translateY(100px)}18%,60%{transform:translateY(66px)}70%{transform:translateY(-12px)}78%{transform:translateY(3px)}84%,100%{transform:translateY(0)}}",
    ".wh2 .pupil{animation:whPeekLook 2.8s both}",
    "@keyframes whPeekLook{0%,24%{transform:translate(0,0)}29%,37%{transform:translate(-3.6px,.4px)}42%,50%{transform:translate(3.6px,.4px)}55%,100%{transform:translate(0,0)}}",
    ".wh2 .open{animation:whShowHide 2.8s both,whBlink 4s 3.6s infinite}",
    ".wh2 .happy{animation:whHideShow 2.8s both}",
    "@keyframes whShowHide{0%,70%{opacity:1}72%,94%{opacity:0}100%{opacity:1}}",
    "@keyframes whHideShow{0%,70%{opacity:0}72%,94%{opacity:1}100%{opacity:0}}",
    ".wh2 .shadow{animation:whFadeIn .3s 2.2s both}",
    ".wh2 .a2{animation:whFloat 3s ease-in-out 3s infinite}",

    // 3 開心跳跳：連跳兩下，空中笑瞇瞇、冒星星
    ".wh3 .a1{animation:whHop 1.9s cubic-bezier(.3,0,.3,1) infinite}",
    "@keyframes whHop{0%,18%{transform:translateY(0)}38%{transform:translateY(-30px)}54%,62%{transform:translateY(0)}74%{transform:translateY(-15px)}86%,100%{transform:translateY(0)}}",
    ".wh3 .a2{animation:whSquash 1.9s infinite}",
    "@keyframes whSquash{0%{transform:scale(1)}12%{transform:scale(1.1,.88)}20%{transform:scale(.94,1.08)}38%{transform:scale(1)}54%{transform:scale(1.1,.9)}60%{transform:scale(.97,1.04)}66%{transform:scale(1)}86%{transform:scale(1.06,.94)}92%,100%{transform:scale(1)}}",
    ".wh3 .open{animation:whAirOpen 1.9s infinite}",
    ".wh3 .happy{animation:whAirHappy 1.9s infinite}",
    "@keyframes whAirOpen{0%,20%,88%,100%{opacity:1}22%,86%{opacity:0}}",
    "@keyframes whAirHappy{0%,20%,88%,100%{opacity:0}22%,86%{opacity:1}}",
    ".wh3 .shadow{animation:whHopShadow 1.9s cubic-bezier(.3,0,.3,1) infinite}",
    "@keyframes whHopShadow{0%,18%,54%,62%,86%,100%{transform:scaleX(1);opacity:1}38%{transform:scaleX(.6);opacity:.45}74%{transform:scaleX(.8);opacity:.7}}",
    ".wh3 .fx{animation:whSpark 1.9s infinite}",
    ".wh3 g:nth-last-of-type(2) .fx{animation-delay:.08s}.wh3 g:nth-last-of-type(1) .fx{animation-delay:.16s}",
    "@keyframes whSpark{0%,28%{opacity:0;transform:scale(0) rotate(0)}38%{opacity:1;transform:scale(1.1) rotate(45deg)}54%,100%{opacity:0;transform:scale(.3) rotate(90deg)}}",

    // 4 眨眼比心：歪頭、右眼眨一下、冒出愛心
    ".wh4 .a1{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh4 .shadow{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh4 .a2{animation:whTilt 3.6s ease-in-out .7s infinite}",
    "@keyframes whTilt{0%,12%,70%,100%{transform:rotate(0)}24%,56%{transform:rotate(-8deg)}}",
    ".wh4 .R .open{animation:whWinkOpen 3.6s .7s infinite}",
    ".wh4 .R .happy{animation:whWinkHappy 3.6s .7s infinite}",
    ".wh4 .L .open{animation:whBlink 3.6s .7s infinite}",
    "@keyframes whWinkOpen{0%,24%,58%,100%{opacity:1}26%,56%{opacity:0}}",
    "@keyframes whWinkHappy{0%,24%,58%,100%{opacity:0}26%,56%{opacity:1}}",
    ".wh4 .fx{animation:whHeart 3.6s .7s infinite}",
    "@keyframes whHeart{0%,26%{opacity:0;transform:translate(0,0) scale(0)}36%{opacity:1;transform:translate(6px,-8px) scale(1.15)}46%{transform:translate(9px,-14px) scale(1)}70%{opacity:0;transform:translate(14px,-30px) scale(.9)}100%{opacity:0}}",

    // 5 眼睛跟著游標：滑鼠移到哪就看哪，停在圖示上會笑
    ".wh5 .a1{animation:whPop .7s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh5 .shadow{animation:whPop .7s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh5 .a2{animation:whFloat 3.4s ease-in-out .9s infinite}",
    ".wh5 .open{animation:whBlink 3.6s 1s infinite}",
    ".wh5:not(.tracking) .pupil{animation:whWander 6s ease-in-out 1s infinite}",
    "@keyframes whWander{0%,10%,100%{transform:translate(0,0)}25%,35%{transform:translate(-3px,1px)}55%,65%{transform:translate(3px,-2px)}80%,88%{transform:translate(1px,3px)}}",
    ".wh5 .pupil{transition:transform .08s linear}",
    ".wh5.pet .open{opacity:0}.wh5.pet .happy{opacity:1}",
    ".wh5.pet .a3{animation:whWiggle .5s ease-in-out infinite}",
    "@keyframes whWiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}",

    // 6 從天而降：掉下來壓扁、揚起灰塵，張開眼睛
    ".wh6 .a1{animation:whDrop .55s cubic-bezier(.55,0,1,.45) both}",
    "@keyframes whDrop{0%{transform:translateY(-170px);opacity:0}15%{opacity:1}100%{transform:translateY(0)}}",
    ".wh6 .a2{animation:whLand .75s .55s both}",
    "@keyframes whLand{0%{transform:scale(1.3,.68)}30%{transform:scale(.9,1.12)}55%{transform:scale(1.06,.95)}80%{transform:scale(.99,1.01)}100%{transform:scale(1)}}",
    ".wh6 .a3{animation:whFloat 3s ease-in-out 1.7s infinite}",
    ".wh6 .shadow{animation:whDropShadow .55s cubic-bezier(.55,0,1,.45) both}",
    "@keyframes whDropShadow{0%{transform:scaleX(.2);opacity:0}100%{transform:scaleX(1);opacity:1}}",
    ".wh6 .shut{animation:whShutThenOpen 1.2s both}",
    "@keyframes whShutThenOpen{0%,70%{opacity:1}74%,100%{opacity:0}}",
    ".wh6 .open{animation:whEyePop 1.2s both,whBlink 4s 2.2s infinite}",
    "@keyframes whEyePop{0%,70%{opacity:0;transform:scale(.3)}84%{opacity:1;transform:scale(1.25)}100%{opacity:1;transform:scale(1)}}",
    ".wh6 .fx{animation:whDust .6s .5s ease-out both}",
    ".wh6 .fx.r{animation-name:whDustR}",
    "@keyframes whDust{0%{opacity:.9;transform:translate(0,0) scale(.4)}100%{opacity:0;transform:translate(-16px,-6px) scale(1.4)}}",
    "@keyframes whDustR{0%{opacity:.9;transform:translate(0,0) scale(.4)}100%{opacity:0;transform:translate(16px,-6px) scale(1.4)}}",

    // 7 鞠躬歡迎：笑瞇瞇地慢慢鞠一個躬（「歡迎光臨」）
    ".wh7 .a1{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh7 .shadow{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh7 .a2{animation:whBowHello 4.4s ease-in-out .7s infinite}",
    "@keyframes whBowHello{0%,8%{transform:rotate(0)}24%,42%{transform:rotate(22deg)}58%,100%{transform:rotate(0)}}",
    ".wh7 .open{animation:whBowOpen 4.4s .7s infinite}",
    ".wh7 .happy{animation:whBowHappy 4.4s .7s infinite}",
    "@keyframes whBowOpen{0%,12%,60%,100%{opacity:1;transform:scaleY(1)}14%,58%{opacity:0}80%{transform:scaleY(1)}82%{transform:scaleY(.1)}84%{transform:scaleY(1)}}",
    "@keyframes whBowHappy{0%,12%,60%,100%{opacity:0}14%,58%{opacity:1}}",
    ".wh7 .fx{animation:whSpark 4.4s .7s infinite}",

    // 8 東張西望：左看右看，看到你了！
    ".wh8 .a1{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh8 .shadow{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh8 .pupil{animation:whLook 5s ease-in-out .7s infinite}",
    "@keyframes whLook{0%,8%{transform:translate(0,0)}14%,28%{transform:translate(-3.6px,.6px)}34%,48%{transform:translate(3.6px,.6px)}54%,62%{transform:translate(2.4px,-3px)}68%,100%{transform:translate(0,0)}}",
    ".wh8 .a2{animation:whLookTilt 5s ease-in-out .7s infinite}",
    "@keyframes whLookTilt{0%,8%,62%,100%{transform:rotate(0)}14%,28%{transform:rotate(-5deg)}34%,48%{transform:rotate(5deg)}70%{transform:translateY(-8px)}76%{transform:translateY(0)}}",
    ".wh8 .open{animation:whLookOpen 5s .7s infinite}",
    ".wh8 .happy{animation:whLookHappy 5s .7s infinite}",
    "@keyframes whLookOpen{0%,68%,94%,100%{opacity:1}70%,92%{opacity:0}}",
    "@keyframes whLookHappy{0%,68%,94%,100%{opacity:0}70%,92%{opacity:1}}",
    ".wh8 .fx{animation:whBang 5s .7s infinite}",
    "@keyframes whBang{0%,66%{opacity:0;transform:scale(0)}72%{opacity:1;transform:scale(1.25)}78%,88%{opacity:1;transform:scale(1)}94%,100%{opacity:0;transform:scale(1)}}",

    // 9 箭頭切換：圖示裡的兩個箭頭一個往右、一個往左滑出去再滑回來（＝換節點），旁邊有速度線，眼睛睜大再笑
    ".wh9 .a1{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh9 .shadow{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh9 .arT{animation:whArrowR 2.6s cubic-bezier(.6,0,.3,1) .8s infinite}",
    ".wh9 .arB{animation:whArrowL 2.6s cubic-bezier(.6,0,.3,1) .9s infinite}",
    "@keyframes whArrowR{0%,15%{transform:translateX(0)}38%{transform:translateX(480px)}38.01%{transform:translateX(-480px)}62%,100%{transform:translateX(0)}}",
    "@keyframes whArrowL{0%,15%{transform:translateX(0)}38%{transform:translateX(-480px)}38.01%{transform:translateX(480px)}62%,100%{transform:translateX(0)}}",
    ".wh9 .open{animation:whWide 2.6s .8s infinite}",
    "@keyframes whWide{0%,12%,64%,100%{transform:scale(1);opacity:1}24%,50%{transform:scale(1.22);opacity:1}66%,92%{opacity:0}}",
    ".wh9 .happy{animation:whSwitchHappy 2.6s .8s infinite}",
    "@keyframes whSwitchHappy{0%,64%,94%,100%{opacity:0}66%,92%{opacity:1}}",
    ".wh9 .fx{animation:whSpeed 2.6s .8s infinite}",
    ".wh9 .fx:nth-of-type(2){animation-delay:.86s}.wh9 .fx:nth-of-type(3){animation-delay:.92s}",
    "@keyframes whSpeed{0%,14%{opacity:0;transform:translateX(10px) scaleX(.3)}26%{opacity:1;transform:translateX(0) scaleX(1)}48%,100%{opacity:0;transform:translateX(-12px) scaleX(.6)}}",

    // 10 彩帶慶祝：從背後噴出彩帶，扭一扭、笑瞇瞇
    ".wh10 .a1{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh10 .shadow{animation:whPop .6s cubic-bezier(.34,1.56,.64,1) both}",
    ".wh10 .a2{animation:whParty 3.4s ease-in-out .5s infinite}",
    "@keyframes whParty{0%{transform:rotate(0)}6%{transform:translateY(-8px) rotate(-6deg)}14%{transform:rotate(6deg)}22%{transform:rotate(-4deg)}30%,100%{transform:rotate(0)}}",
    ".wh10 .open{animation:whPartyOpen 3.4s .5s infinite}",
    ".wh10 .happy{animation:whPartyHappy 3.4s .5s infinite}",
    "@keyframes whPartyOpen{0%,2%,46%,100%{opacity:1}4%,44%{opacity:0}}",
    "@keyframes whPartyHappy{0%,2%,46%,100%{opacity:0}4%,44%{opacity:1}}",
    ".wh10 .fx{animation:whConfetti 3.4s cubic-bezier(.2,.7,.4,1) .5s infinite}",
    "@keyframes whConfetti{0%{opacity:0;transform:translate(0,0) rotate(0) scale(.4)}4%{opacity:1}30%{opacity:1;transform:translate(var(--x),var(--y)) rotate(var(--r)) scale(1)}60%{opacity:0;transform:translate(var(--x),calc(var(--y) + 40px)) rotate(calc(var(--r) * 2)) scale(1)}100%{opacity:0}}",

    "@media (prefers-reduced-motion:reduce){.wh *{animation:none!important}.wh .fx{opacity:0}}"
  ].join("\n");

  var VARIANTS = [
    { name: "彈出眨眼", desc: "彈出來、輕輕飄浮，固定眨兩下眼" },
    { name: "探頭", desc: "先從地面露出一雙眼睛左看右看，再跳出來笑" },
    { name: "開心跳跳", desc: "連跳兩下，在空中笑瞇瞇、冒星星" },
    { name: "眨眼比心", desc: "歪頭、右眼眨一下，冒出一顆愛心" },
    { name: "眼睛跟著游標", desc: "眼睛跟著滑鼠轉；滑鼠停在圖示上會笑著扭一扭" },
    { name: "從天而降", desc: "掉下來壓扁、揚起灰塵，再睜開眼睛" },
    { name: "鞠躬歡迎", desc: "笑瞇瞇地慢慢鞠一個躬（歡迎光臨）" },
    { name: "東張西望", desc: "左看右看，頭上跳出驚嘆號：找到你了！" },
    { name: "箭頭切換", desc: "圖示裡的箭頭滑出去再滑回來（換節點），速度線、眼睛睜大再笑" },
    { name: "彩帶慶祝", desc: "從背後噴出彩帶，扭一扭、笑瞇瞇" }
  ];

  var ARROW_T = "92,140 320,140 320,82 420,166 320,250 320,192 92,192";
  var ARROW_B = "420,320 192,320 192,262 92,346 192,430 192,372 420,372";
  function icon(uid) {
    // 跟 scripts/gen-icons.mjs 同一份畫法；箭頭分開成兩組（箭頭切換那一種要各自動），影子跟著自己的箭頭
    function arrow(cls, pts) {
      return '<g class="' + cls + '"><polygon transform="translate(0,9)" points="' + pts + '" fill="rgb(120,20,55)" fill-opacity="0.18"/>' +
        '<polygon points="' + pts + '" fill="white"/></g>';
    }
    return '<g transform="translate(64,46) scale(0.140625)">' +
      '<rect x="0" y="0" width="512" height="512" rx="112" ry="112" fill="url(#' + uid + 'bg)"/>' +
      '<g clip-path="url(#' + uid + 'clip)">' + arrow("arT", ARROW_T) + arrow("arB", ARROW_B) + "</g></g>";
  }
  function eye(x, side) {
    var shut = side === "L" ? "M-4.5 -4.5 L4 0 L-4.5 4.5" : "M4.5 -4.5 L-4 0 L4.5 4.5";
    return '<g transform="translate(' + x + ',43)"><g class="eye ' + side + '">' +
      '<circle r="12" fill="rgb(250,120,165)" stroke="rgb(235,90,140)" stroke-width="1.6"/>' +
      '<g class="open"><circle r="8.4" fill="#fff"/><g class="pupil"><circle r="4.4" fill="' + INK + '"/><circle cx="1.5" cy="-1.6" r="1.4" fill="#fff"/></g></g>' +
      '<path class="happy" d="M-6 3 Q0 -5.5 6 3" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path class="shut" d="' + shut + '" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</g></g>";
  }
  function star(x, y, s, color) {
    // 位置放在外層 g：CSS 的 transform 會蓋掉元素自己的 transform 屬性
    return '<g transform="translate(' + x + "," + y + ") scale(" + s + ')"><path class="fx" d="M0 -6 L1.6 -1.6 L6 0 L1.6 1.6 L0 6 L-1.6 1.6 L-6 0 L-1.6 -1.6Z" fill="' + (color || "#ffc83d") + '"/></g>';
  }
  function extras(n) {
    var back = "", front = "";
    if (n === 2) back += '<rect class="ground" x="40" y="118" width="120" height="4" rx="2"/>';
    if (n === 3) front += star(46, 36, 1, "#ffc83d") + star(156, 28, 1.2, "#7ad7f0") + star(152, 70, .8, "#fb7299");
    if (n === 4) front += '<g transform="translate(146,26)"><path class="fx" d="M0 3 C0 -1 -5 -3 -6.5 1 C-7.5 4.5 -3.5 7.5 0 10.5 C3.5 7.5 7.5 4.5 6.5 1 C5 -3 0 -1 0 3Z" fill="#ff4d7d"/></g>';
    if (n === 6) front += '<g fill="var(--border,#d5d8dc)"><circle class="fx" cx="66" cy="116" r="6"/><circle class="fx r" cx="134" cy="116" r="6"/></g>';
    if (n === 7) front += star(40, 52, 1, "#ffc83d") + star(162, 40, .9, "#7ad7f0");
    if (n === 8) front += '<g class="fx" fill="var(--accent,#fb7299)"><rect x="97.5" y="2" width="5" height="15" rx="2.5"/><circle cx="100" cy="23" r="2.8"/></g>';
    if (n === 9) back += '<g stroke="var(--muted,#9499a0)" stroke-width="3" stroke-linecap="round">' +
      '<line class="fx" x1="30" y1="66" x2="52" y2="66"/><line class="fx" x1="22" y1="82" x2="52" y2="82"/><line class="fx" x1="32" y1="98" x2="52" y2="98"/></g>';
    if (n === 10) {
      var colors = ["#fb7299", "#ffc83d", "#7ad7f0", "#2ba471", "#8041c8", "#ff8a3d"];
      var bits = [[-70, -40, 200], [-52, -64, -160], [-24, -78, 120], [6, -84, -220], [34, -74, 180], [60, -56, -140], [76, -30, 240],
        [-80, -10, -200], [84, -6, 160], [-40, -50, 300], [44, -40, -260], [-12, -60, 90], [20, -66, -110], [-62, -24, 140]];
      back += bits.map(function (b, i) {
        var c = colors[i % colors.length], style = ' style="--x:' + b[0] + "px;--y:" + b[1] + "px;--r:" + b[2] + 'deg"';
        return i % 3 === 2 ? '<circle class="fx" cx="100" cy="76" r="2.6" fill="' + c + '"' + style + "/>" :
          '<rect class="fx" x="97.5" y="72" width="5" height="9" rx="1" fill="' + c + '"' + style + "/>";
      }).join("");
    }
    return { back: back, front: front };
  }
  var seq = 0;
  function svg(n) {
    var uid = "wh" + (++seq) + "_", x = extras(n);
    // 探頭：地面以下的部分藏起來
    var clip = n === 2 ? ' clip-path="url(#' + uid + 'ground)"' : "";
    return '<svg class="wh wh' + n + '" viewBox="0 0 200 150" aria-hidden="true">' +
      "<defs>" +
      '<linearGradient id="' + uid + 'bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="rgb(255,138,176)"/><stop offset="100%" stop-color="rgb(235,90,140)"/></linearGradient>' +
      '<clipPath id="' + uid + 'clip"><rect width="512" height="512" rx="112" ry="112"/></clipPath>' +
      '<clipPath id="' + uid + 'ground"><rect x="-100" y="-200" width="400" height="318"/></clipPath>' +
      "</defs>" + x.back +
      '<ellipse class="shadow" cx="100" cy="121" rx="34" ry="4"/>' +
      "<g" + clip + '><g class="a1"><g class="a2"><g class="a3">' + icon(uid) + eye(72, "L") + eye(128, "R") + "</g></g></g></g>" +
      x.front + "</svg>";
  }
  function style() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  // 5：眼睛跟著游標（眼珠最多偏 3.6px），滑鼠停在圖示上就笑
  function follow(root) {
    var pupils = root.querySelectorAll(".pupil"), lids = root.querySelectorAll(".eye > circle"), body = root.querySelector(".a3");
    function move(e) {
      root.classList.add("tracking");
      lids.forEach(function (lid, i) {
        var r = lid.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        var d = Math.hypot(dx, dy) || 1, k = Math.min(3.6, d / 40) / d;
        pupils[i].style.transform = "translate(" + (dx * k).toFixed(2) + "px," + (dy * k).toFixed(2) + "px)";
      });
      var b = body.getBoundingClientRect();
      root.classList.toggle("pet", e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", function () { root.classList.remove("pet"); });
  }
  function render(el, n) {
    n = Math.max(1, Math.min(VARIANTS.length, n | 0 || 1));
    style();
    el.innerHTML = svg(n);
    if (n === 5) follow(el.firstChild);
    return el.firstChild;
  }
  return { render: render, VARIANTS: VARIANTS };
})();
