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
BBFeatures.watch(function (flags) {
  BBFeatures.check(flags, "cloud_sync").then(function (r) { setCloud(r.ok && !laterClicked); });
});
