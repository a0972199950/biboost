// 登入回跳頁（auth.html）：網址上的 code／state（或 error）→ BBCloud.finishLogin 換 token。
// 從歡迎頁登入的（cloudAuthPending.back）：整個登入都在歡迎頁那個小視窗裡，換完 token 直接換回歡迎頁（不會多一頁）。
// 從 popup 登入的（小視窗）：顯示雲端備份面板；備份、還原完成或按「關閉」就把這個視窗關掉。
// 網址上的 code 用完就從網址列拿掉（重新整理也不會再送一次）
"use strict";
document.title = t("authTitle");
document.documentElement.lang = uiLanguage();
(function () {
  var name = t("extName"), cut = name.indexOf(" - ");
  $("brand").textContent = cut > 0 ? name.slice(0, cut) : name;
  $("tagline").textContent = cut > 0 ? name.slice(cut + 3) : "";
})();
function closeSelf() {
  try { chrome.tabs.getCurrent(function (tab) { if (tab) chrome.tabs.remove(tab.id); else window.close(); }); }
  catch (e) { window.close(); }
}
(function () {
  var q = new URLSearchParams(location.search);
  var params = { code: q.get("code") || "", state: q.get("state") || "", error: q.get("error") || "" };
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  var head = $("authHead"), lead = $("authLead");
  head.textContent = t("cloudWorking");
  // back 要先拿：失敗時 finishLogin 不會回傳它
  chrome.storage.local.get("cloudAuthPending", function (s) {
    var back = (s && s.cloudAuthPending && s.cloudAuthPending.back) || "";
    var backUrl = /^[a-z]+\.html$/.test(back) ? chrome.runtime.getURL(back) : "";
    BBCloud.finishLogin(params).then(function () {
      if (backUrl) { location.replace(backUrl); return; }
      head.textContent = t("authDone");
      lead.textContent = ""; // 面板裡已經有「已登入：email」
      BBCloudUI.mount($("authPanel"), { onDone: closeSelf, onCancel: closeSelf, cancelText: t("cloudClose") });
    }, function (e) {
      head.textContent = t("authFail");
      lead.textContent = t("authFailHint").replace("{code}", (e && e.code) || "error");
      var b = document.createElement("button");
      b.type = "button";
      b.className = "authBack";
      b.textContent = t(backUrl ? "authBack" : "cloudClose");
      b.addEventListener("click", function () { if (backUrl) location.replace(backUrl); else closeSelf(); });
      $("authPanel").appendChild(b);
    });
  });
})();
