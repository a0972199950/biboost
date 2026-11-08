// 歡迎頁（welcome.html）：全新安裝時 background 開成小視窗。開場動畫（welcome-hero.js：探頭→一直開心跳跳＋彩帶）、歡迎詞、三步驟；
// 雲端備份面板（fresh 模式：登入／從雲端恢復設定／取消）直接畫在頁面上，只在功能開關 cloud_sync 開啟時出現。
// 恢復完、按「取消」或「稍後再說」就關掉視窗
"use strict";
document.title = t("welcomeTitle");
document.documentElement.lang = uiLanguage();
(function () {
  var name = t("extName"), cut = name.indexOf(" - ");
  $("brand").textContent = cut > 0 ? name.slice(0, cut) : name;
  $("tagline").textContent = cut > 0 ? name.slice(cut + 3) : "";
})();
["welcomeTitle", "welcomeBody", "welcomeTip1", "welcomeTip2", "welcomeTip3"].forEach(function (k) { $(k).textContent = t(k); });
BBWelcomeHero.render($("hero"));

function closeSelf() {
  try { chrome.tabs.getCurrent(function (tab) { if (tab) chrome.tabs.remove(tab.id); else window.close(); }); }
  catch (e) { window.close(); }
}
var cloudPanel = null;
BBFeatures.watch(function (flags) {
  var on = BBFeatures.enabled(flags, "cloud_sync"), box = $("cloudPanel");
  box.hidden = !on;
  if (on && !cloudPanel) cloudPanel = BBCloudUI.mount(box, { fresh: true, back: "welcome.html", onDone: closeSelf, onCancel: closeSelf, laterText: t("cloudLater") });
  if (!on && cloudPanel) { cloudPanel.destroy(); box.textContent = ""; cloudPanel = null; }
});
