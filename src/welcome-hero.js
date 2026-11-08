// 歡迎頁的開場動畫：擴充圖示（跟 scripts/gen-icons.mjs 同一份畫法，不改）＋頂端兩角一雙眼睛（跟 popup 道歉動畫同一種長法）。
// 使用者從 10 種風格裡挑了 2＋3＋10 合在一起：
//   先「探頭」：從地面只露出一雙眼睛，左看右看，跳出來笑瞇瞇（2.8 秒）
//   接著一直「開心跳跳」：連跳兩下、停一下，空中笑瞇瞇（每輪 1.9 秒）
//   每次起跳，周圍噴出「彩帶」（兩下各一組）
//   BBWelcomeHero.render(el)  在 el 裡畫出來
// 結構：svg > 彩帶 > 地面、影子 > .a1（探頭）> .a2（跳）> .a3（落地壓扁）> 圖示＋眼睛
// 眼睛：.open（白眼珠＋.pupil 黑眼珠）、.happy（笑瞇瞇 ^），用 opacity 切換
var BBWelcomeHero = (function () {
  var STYLE_ID = "bbWelcomeHeroStyle";
  var INK = "#3a1424";
  var INTRO = "2.8s", HOP = "1.9s";
  var CSS = [
    ".wh{display:block;width:220px;height:165px;margin:0 auto;overflow:visible}",
    ".wh .a1,.wh .a2,.wh .a3{transform-box:view-box;transform-origin:100px 118px}",
    ".wh .open,.wh .happy,.wh .shadow,.wh .fx{transform-box:fill-box;transform-origin:center}",
    ".wh .happy{opacity:0}",
    ".wh .shadow{fill:rgba(0,0,0,.12)}",
    ".wh .ground{fill:var(--border,#e3e5e7)}",
    ".wh .fx{opacity:0}",

    // 探頭：先只露出眼睛（地面以下藏起來），左看右看，跳出來
    ".wh .a1{animation:whPeek " + INTRO + " ease-out both}",
    "@keyframes whPeek{0%{transform:translateY(100px)}18%,60%{transform:translateY(66px)}70%{transform:translateY(-12px)}78%{transform:translateY(3px)}84%,100%{transform:translateY(0)}}",
    ".wh .pupil{animation:whPeekLook " + INTRO + " both}",
    "@keyframes whPeekLook{0%,24%{transform:translate(0,0)}29%,37%{transform:translate(-3.6px,.4px)}42%,50%{transform:translate(3.6px,.4px)}55%,100%{transform:translate(0,0)}}",

    // 開心跳跳（探頭完接著跳，一直重複）：連跳兩下，空中笑瞇瞇
    ".wh .a2{animation:whHop " + HOP + " cubic-bezier(.3,0,.3,1) " + INTRO + " infinite}",
    "@keyframes whHop{0%,18%{transform:translateY(0)}38%{transform:translateY(-30px)}54%,62%{transform:translateY(0)}74%{transform:translateY(-15px)}86%,100%{transform:translateY(0)}}",
    ".wh .a3{animation:whSquash " + HOP + " " + INTRO + " infinite}",
    "@keyframes whSquash{0%{transform:scale(1)}12%{transform:scale(1.1,.88)}20%{transform:scale(.94,1.08)}38%{transform:scale(1)}54%{transform:scale(1.1,.9)}60%{transform:scale(.97,1.04)}66%{transform:scale(1)}86%{transform:scale(1.06,.94)}92%,100%{transform:scale(1)}}",
    // 眼睛：探頭時睜眼、跳出來那下笑；之後每次在空中笑（後面那個動畫開始後蓋過前面的）
    ".wh .open{animation:whPeekOpen " + INTRO + " both,whAirOpen " + HOP + " " + INTRO + " infinite}",
    ".wh .happy{animation:whPeekHappy " + INTRO + " both,whAirHappy " + HOP + " " + INTRO + " infinite}",
    "@keyframes whPeekOpen{0%,70%{opacity:1}72%,94%{opacity:0}100%{opacity:1}}",
    "@keyframes whPeekHappy{0%,70%{opacity:0}72%,94%{opacity:1}100%{opacity:0}}",
    "@keyframes whAirOpen{0%,20%,88%,100%{opacity:1}22%,86%{opacity:0}}",
    "@keyframes whAirHappy{0%,20%,88%,100%{opacity:0}22%,86%{opacity:1}}",
    // 影子：探頭時沒有，跳出來才出現；跳起來時變小變淡
    ".wh .shadow{animation:whFadeIn .3s 2.2s both,whHopShadow " + HOP + " cubic-bezier(.3,0,.3,1) " + INTRO + " infinite}",
    "@keyframes whFadeIn{from{opacity:0}to{opacity:1}}",
    "@keyframes whHopShadow{0%,18%,54%,62%,86%,100%{transform:scaleX(1);opacity:1}38%{transform:scaleX(.6);opacity:.45}74%{transform:scaleX(.8);opacity:.7}}",

    // 彩帶：每次起跳噴一組（第一下大跳用 .b1、第二下小跳用 .b2，飛得近一點）
    ".wh .fx.b1{animation:whConfetti1 " + HOP + " cubic-bezier(.2,.7,.4,1) " + INTRO + " infinite}",
    ".wh .fx.b2{animation:whConfetti2 " + HOP + " cubic-bezier(.2,.7,.4,1) " + INTRO + " infinite}",
    "@keyframes whConfetti1{0%,16%{opacity:0;transform:translate(0,0) rotate(0) scale(.4)}20%{opacity:1}40%{opacity:1;transform:translate(var(--x),var(--y)) rotate(var(--r)) scale(1)}58%,100%{opacity:0;transform:translate(var(--x),calc(var(--y) + 30px)) rotate(calc(var(--r) * 2)) scale(1)}}",
    "@keyframes whConfetti2{0%,54%{opacity:0;transform:translate(0,0) rotate(0) scale(.4)}58%{opacity:1}74%{opacity:1;transform:translate(calc(var(--x) * .7),calc(var(--y) * .7)) rotate(var(--r)) scale(.9)}90%,100%{opacity:0;transform:translate(calc(var(--x) * .7),calc(var(--y) * .7 + 24px)) rotate(calc(var(--r) * 2)) scale(.9)}}",

    "@media (prefers-reduced-motion:reduce){.wh *{animation:none!important}.wh .fx{opacity:0}}"
  ].join("\n");

  var ARROW_T = "92,140 320,140 320,82 420,166 320,250 320,192 92,192";
  var ARROW_B = "420,320 192,320 192,262 92,346 192,430 192,372 420,372";
  function icon(uid) {
    // 跟 scripts/gen-icons.mjs 同一份畫法（影子跟著自己的箭頭，畫出來一樣）
    function arrow(pts) {
      return '<polygon transform="translate(0,9)" points="' + pts + '" fill="rgb(120,20,55)" fill-opacity="0.18"/><polygon points="' + pts + '" fill="white"/>';
    }
    return '<g transform="translate(64,46) scale(0.140625)">' +
      '<rect x="0" y="0" width="512" height="512" rx="112" ry="112" fill="url(#' + uid + 'bg)"/>' + arrow(ARROW_T) + arrow(ARROW_B) + "</g>";
  }
  function eye(x) {
    return '<g transform="translate(' + x + ',43)"><g class="eye">' +
      '<circle r="12" fill="rgb(250,120,165)" stroke="rgb(235,90,140)" stroke-width="1.6"/>' +
      '<g class="open"><circle r="8.4" fill="#fff"/><g class="pupil"><circle r="4.4" fill="' + INK + '"/><circle cx="1.5" cy="-1.6" r="1.4" fill="#fff"/></g></g>' +
      '<path class="happy" d="M-6 3 Q0 -5.5 6 3" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round"/>' +
      "</g></g>";
  }
  // 彩帶：從圖示背後往四周噴（[x 位移, y 位移, 旋轉角度]），單數一組給第一下、雙數給第二下
  var COLORS = ["#fb7299", "#ffc83d", "#7ad7f0", "#2ba471", "#8041c8", "#ff8a3d"];
  var BITS = [[-70, -40, 200], [-52, -64, -160], [-24, -78, 120], [6, -84, -220], [34, -74, 180], [60, -56, -140], [76, -30, 240],
    [-80, -10, -200], [84, -6, 160], [-40, -50, 300], [44, -40, -260], [-12, -60, 90], [20, -66, -110], [-62, -24, 140]];
  function confetti() {
    return BITS.map(function (b, i) {
      var cls = "fx " + (i % 2 ? "b2" : "b1"), c = COLORS[i % COLORS.length];
      var style = ' style="--x:' + b[0] + "px;--y:" + b[1] + "px;--r:" + b[2] + 'deg"';
      return i % 3 === 2 ? '<circle class="' + cls + '" cx="100" cy="76" r="2.6" fill="' + c + '"' + style + "/>" :
        '<rect class="' + cls + '" x="97.5" y="72" width="5" height="9" rx="1" fill="' + c + '"' + style + "/>";
    }).join("");
  }
  var seq = 0;
  function svg() {
    var uid = "wh" + (++seq) + "_";
    return '<svg class="wh" viewBox="0 0 200 150" aria-hidden="true">' +
      "<defs>" +
      '<linearGradient id="' + uid + 'bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="rgb(255,138,176)"/><stop offset="100%" stop-color="rgb(235,90,140)"/></linearGradient>' +
      '<clipPath id="' + uid + 'ground"><rect x="-100" y="-200" width="400" height="318"/></clipPath>' +
      "</defs>" + confetti() +
      '<rect class="ground" x="40" y="118" width="120" height="4" rx="2"/>' +
      '<ellipse class="shadow" cx="100" cy="121" rx="34" ry="4"/>' +
      '<g clip-path="url(#' + uid + 'ground)"><g class="a1"><g class="a2"><g class="a3">' + icon(uid) + eye(72) + eye(128) + "</g></g></g></g></svg>";
  }
  function style() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function render(el) {
    style();
    el.innerHTML = svg();
    return el.firstChild;
  }
  return { render: render };
})();
