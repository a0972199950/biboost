// 登入回跳頁（auth.html）：網址上的 code／state（或 error）→ BBCloud.finishLogin 換 token → 顯示雲端備份面板。
// 網址上的 code 用完就從網址列拿掉（重新整理也不會再送一次）
"use strict";
document.title = t("authTitle");
document.documentElement.lang = uiLanguage();
(function () {
  var q = new URLSearchParams(location.search);
  var params = { code: q.get("code") || "", state: q.get("state") || "", error: q.get("error") || "" };
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  var head = $("authHead"), lead = $("authLead");
  head.textContent = t("cloudWorking");
  BBCloud.finishLogin(params).then(function (r) {
    head.textContent = t("authDone");
    lead.textContent = r.email ? t("cloudSignedInAs").replace("{email}", r.email) : "";
    BBCloudUI.mount($("authPanel"));
  }, function (e) {
    head.textContent = t("authFail");
    lead.textContent = t("authFailHint").replace("{code}", (e && e.code) || "error");
  });
})();
