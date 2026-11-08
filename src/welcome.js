// 歡迎頁（welcome.html）：全新安裝時 background 開成小視窗。開場動畫（welcome-hero.js：探頭→一直開心跳跳＋彩帶）、歡迎詞、主要賣點；
// 雲端備份面板（fresh 模式）只在功能開關 cloud_sync 開著、而且可以用時出現（BBFeatures.check；不能用就整塊不顯示）。
//   未登入：Google 登入／稍後再說（收起這塊）
//   登入後（同一個視窗換頁回來）：不再顯示歡迎的部分，只問要不要從雲端恢復
// 最下面「開始使用」：background 關掉這個視窗、打開擴充的 popup 一次（打不開就只關視窗）。從雲端恢復完也一樣
"use strict";
document.title = t("welcomeTitle");
document.documentElement.lang = uiLanguage();
(function () {
  var name = t("extName"), cut = name.indexOf(" - ");
  $("brand").textContent = cut > 0 ? name.slice(0, cut) : name;
  $("tagline").textContent = cut > 0 ? name.slice(cut + 3) : "";
})();
$("welcomeTitle").textContent = t("welcomeTitle");
// 賣點一句一行（自動換行會切在句子中間，例如「…裝／好就能用」）
t("welcomeBody").split(/(?<=[。！？.!?])\s*/).filter(Boolean).forEach(function (line) {
  var span = document.createElement("span");
  span.textContent = line;
  $("welcomeBody").appendChild(span);
});
$("startBtn").textContent = t("cloudStart");
BBWelcomeHero.render($("hero"));

function closeSelf() {
  try { chrome.tabs.getCurrent(function (tab) { if (tab) chrome.tabs.remove(tab.id); else window.close(); }); }
  catch (e) { window.close(); }
}
// 開始使用：交給 background（關視窗之後才能在一般視窗打開 popup）；background 沒回應就自己關
function start() {
  $("startBtn").disabled = true;
  try {
    chrome.windows.getCurrent(function (w) {
      chrome.runtime.sendMessage({ type: "CDN_SWITCHER_WELCOME_DONE", windowId: w && w.id }, function (r) {
        void chrome.runtime.lastError;
        if (!r || !r.ok) closeSelf();
      });
    });
  } catch (e) { closeSelf(); }
}
$("startBtn").addEventListener("click", start);

// 已登入（登入完換回這頁）：歡迎的部分收起來
function showWelcome(signedIn) { $("welcomeHero").hidden = !!signedIn; }
BBCloud.status().then(function (st) { showWelcome(st.account); });
chrome.storage.onChanged.addListener(function (ch, area) { if (area === "local" && ch.cloudAccount) showWelcome(ch.cloudAccount.newValue); });

var cloudPanel = null, laterClicked = false;
function setCloud(on) {
  var box = $("cloudPanel");
  box.hidden = !on;
  if (on && !cloudPanel) cloudPanel = BBCloudUI.mount(box, { fresh: true, back: "welcome.html", onDone: start, onLater: function () { laterClicked = true; setCloud(false); } });
  if (!on && cloudPanel) { cloudPanel.destroy(); box.textContent = ""; cloudPanel = null; }
}
// 視窗高度跟著內容：background 先開 500×700，但瀏覽器的預設縮放（例如 110%）、語言的字數、雲端備份那塊有沒有出現都會改變內容高度，
// 裝不下就要捲動才看得到「開始使用」（使用者的 Chrome 預設 110% 就發生過）。內容變了或視窗大小變了就重新對齊，最多連調幾次。
// 視窗高度是螢幕單位、內容是 CSS 單位（差一個縮放倍率 k）：先當 1，調過一次後用實際變化量算出來
var fit = { tries: 0, k: 1, lastH: 0, lastInner: 0, timer: 0 };
function fitWindow() {
  if (!chrome.windows || !chrome.windows.update) return;
  chrome.windows.getCurrent(function (w) {
    if (!w || w.type !== "popup" || w.state !== "normal" || location.pathname.indexOf("welcome.html") < 0) return;
    var need = document.querySelector(".top").offsetHeight + document.querySelector("main").offsetHeight;
    var diff = need - window.innerHeight;
    if (Math.abs(diff) < 3 || fit.tries >= 4) return;
    if (fit.lastH && w.height !== fit.lastH && window.innerHeight !== fit.lastInner) fit.k = (w.height - fit.lastH) / (window.innerHeight - fit.lastInner);
    fit.lastH = w.height;
    fit.lastInner = window.innerHeight;
    fit.tries++;
    var h = Math.round(w.height + diff * fit.k);
    chrome.windows.update(w.id, { height: Math.max(360, Math.min(h, screen.availHeight)) }, function () { void chrome.runtime.lastError; });
  });
}
function fitSoon(reset) {
  if (reset) fit.tries = 0;
  clearTimeout(fit.timer);
  fit.timer = setTimeout(fitWindow, 120);
}
try { new ResizeObserver(function () { fitSoon(true); }).observe(document.querySelector("main")); } catch (e) {}
window.addEventListener("resize", function () { fitSoon(false); });

BBFeatures.watch(function (flags) {
  BBFeatures.check(flags, "cloud_sync").then(function (r) { setCloud(r.ok && !laterClicked); });
});
