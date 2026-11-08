// 歡迎頁（welcome.html）：全新安裝時 background 開。雲端備份面板（登入／備份／還原）直接畫在頁面上，只在功能開關 cloud_sync 開啟時出現
"use strict";
document.title = t("welcomeTitle");
document.documentElement.lang = uiLanguage();
$("welcomeTitle").textContent = t("welcomeTitle");
$("welcomeBody").textContent = t("welcomeBody");
var cloudPanel = null;
BBFeatures.watch(function (flags) {
  var on = BBFeatures.enabled(flags, "cloud_sync"), box = $("cloudPanel");
  box.hidden = !on;
  if (on && !cloudPanel) cloudPanel = BBCloudUI.mount(box);
  if (!on && cloudPanel) { cloudPanel.destroy(); box.textContent = ""; cloudPanel = null; }
});
