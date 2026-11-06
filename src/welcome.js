// 歡迎頁（welcome.html）：全新安裝時 background 開。「已經有備份？從雲端恢復」只在功能開關 cloud_sync 開啟時出現
"use strict";
document.title = t("welcomeTitle");
document.documentElement.lang = uiLanguage();
$("welcomeTitle").textContent = t("welcomeTitle");
$("welcomeBody").textContent = t("welcomeBody");
$("restoreLink").textContent = t("welcomeRestoreLink");
$("restoreLink").addEventListener("click", function () { BBCloudUI.open(); });
BBFeatures.watch(function (flags) { $("restoreRow").hidden = !BBFeatures.enabled(flags, "cloud_sync"); });
