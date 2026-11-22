"use strict";
/*
 * 公告視窗（announcement.html）：popup 跑馬燈點下去，由 background 開成獨立視窗（同問題回報）；?id=<n> 是點到的公告，只顯示那一則。
 *  - 資料同 popup：storage.local.announcementFeed（popup 抓的快取），找不到那一則就向 report worker 的 GET /v2/announcements 重抓
 *  - type "lottery"：標題「抽獎活動」，內容由 lottery-text.js 依抽獎資料組；抽獎有備註（v2 的 note，後台寫的 { 語言: HTML }）時接一個「備註」區塊
 *    （html-sanitize.js 依白名單重建），下面接參加方式、「下載測速工具與教學」
 *  - type "html"：標題是公告的標題，內容是後台寫的 HTML（html-sanitize.js 依白名單重建），只有「關閉」
 *  - 抽獎公告的抽獎已經結束、公告還在自己的期間內：只顯示抽獎標題與「已經結束」
 *  - type "survey"：popup 直接開問卷視窗（survey-window.html），這裡只負責萬一開到時轉過去
 */
var ANNOUNCE_PATH = "/v2/announcements"; // 同 popup.js：商店版問正式環境、開發版問測試環境（common.js 的 bbApiBase）
var ANNOUNCE_FEED_V = 2; // 同 popup.js：announcementFeed 的格式版本，不同的舊快取不用
var SPEEDTEST_DOC_URL = "https://lazy-cv.com/docs/bilibili-cdn-speedtest";
// 公告（後台寫的 HTML）裡的問卷連結 https://www.bilibili.com/#bb-survey=<問卷 id>（沒有 id＝任一份還沒填完的）：
// 不另開網頁，請背景在目前的 B 站分頁打開問卷（不是 B 站就開新分頁），見 background.js 的 openSurveyFromAnnouncement
var SURVEY_LINK_RE = /^https:\/\/www\.bilibili\.com\/?#bb-survey(?:=([a-z0-9][a-z0-9-]{1,47}))?$/;
function openLink(url) {
  var m = SURVEY_LINK_RE.exec(url);
  if (m) {
    try { chrome.runtime.sendMessage({ type: "BB_SURVEY_OPEN_FROM_ANNOUNCEMENT", surveyId: m[1] || "" }, function () { void chrome.runtime.lastError; }); return; } catch (e) {}
  }
  openTab(url);
}

var params = new URLSearchParams(location.search);
var ID = /^\d+$/.test(params.get("id") || "") ? Number(params.get("id")) : null;

// t / uiLanguage / uiLangCode / $ / openTab / pickLang come from common.js
var LANG = uiLangTag(); // lottery-text.js and the announcement API use "zh-TW"-style tags
function el(tag, text) {
  var e = document.createElement(tag);
  e.textContent = text;
  return e;
}

document.documentElement.lang = uiLanguage();
$("how").textContent = t("lotteryWinHow");
$("ctaBtn").textContent = t("lotteryWinCta");
$("closeBtn2").textContent = t("lotteryWinClose");
$("closeBtn").setAttribute("aria-label", t("lotteryWinClose"));
$("closeBtn").addEventListener("click", function () { window.close(); });
$("closeBtn2").addEventListener("click", function () { window.close(); });
$("ctaBtn").addEventListener("click", function () {
  openTab(SPEEDTEST_DOC_URL + "?utm_source=extension&utm_medium=referral&utm_campaign=lottery&utm_content=" + uiLangCode());
});

function setTitle(text, gift) {
  document.title = text;
  $("title").textContent = text;
  $("giftIcon").style.display = gift ? "" : "none";
}

// 抽獎公告：依抽獎資料組文字；資料不完整就當作找不到。抽獎已結束：改版前自動建的公告（沒有自己的期間，ownPeriod false）當作找不到；
// 有自己期間的（後台手動新增，公告還在期間內）說「這個抽獎活動已經結束」
function renderLottery(l, ownPeriod) {
  var c;
  try { c = LotteryText.compose(l, LANG); } catch (e) { return false; }
  if (Date.now() >= l.endsAt) {
    if (!ownPeriod) return false;
    setTitle(t("lotteryWinTitle"), true);
    $("body").className = "lot";
    $("body").appendChild(el("h2", c.title));
    $("body").appendChild(el("p", t("lotteryEnded"))).className = "ended";
    return true;
  }
  setTitle(t("lotteryWinTitle"), true);
  var sec = $("body");
  sec.className = "lot";
  sec.appendChild(el("h2", c.title));
  sec.appendChild(el("p", c.eligible));
  if (c.ispList) sec.appendChild(el("p", c.ispList)).className = "ispList";
  [c.period, c.prize, c.draw].forEach(function (line) { sec.appendChild(el("p", line)); });
  var noteHtml = l.note && typeof l.note === "object" ? pickLang(l.note) : l.note; // v2：{ 語言: HTML }
  if (noteHtml) {
    var note = sec.appendChild(document.createElement("div"));
    note.className = "lotNote";
    note.appendChild(el("div", t("lotteryNote"))).className = "lotNoteHead";
    var noteBody = note.appendChild(document.createElement("div"));
    noteBody.className = "rich";
    HtmlSanitize.render(noteHtml, noteBody, openLink);
  }
  $("how").style.display = "";
  $("ctaBtn").style.display = "";
  return true;
}

// 一般公告：標題＋後台寫的 HTML
function renderHtml(a) {
  var title = pickLang(a.title), html = pickLang(a.html);
  if (!title) return false;
  setTitle(title, false);
  $("body").className = "rich";
  HtmlSanitize.render(html, $("body"), openLink);
  return true;
}

// 問卷公告：popup 直接開問卷視窗，不會開到這裡；萬一開到了（例如舊的視窗網址）就換成問卷視窗
function openSurvey(a) {
  if (!a.surveyId) return false;
  location.replace("survey-window.html?id=" + encodeURIComponent(a.surveyId));
  return true;
}

function render(items) {
  var a = (items || []).filter(function (it) { return it && it.id === ID; })[0];
  var own = !!a && (a.startsAt != null || a.endsAt != null);
  var ok = a && (a.type === "lottery" ? a.lottery && renderLottery(a.lottery, own) : a.type === "html" ? renderHtml(a) : a.type === "survey" && openSurvey(a));
  if (ok) return true;
  setTitle(t("lotteryBarLabel"), false);
  $("body").textContent = "";
  $("body").appendChild(el("p", t("announceGone"))).className = "empty";
  return false;
}

chrome.storage.local.get({ announcementFeed: null }, function (s) {
  bbApiBase().then(function (api) {
    var feed = s.announcementFeed;
    // 別的環境（開發版／商店版切換）的快取不用
    var cached = feed && feed.v === ANNOUNCE_FEED_V && Array.isArray(feed.items) && (feed.api || BB_API_PROD) === api ? feed.items : null;
    // 快取裡有這一則就直接畫；沒有（舊格式、還沒抓過、剛新增）才重抓
    if (cached && cached.some(function (it) { return it && it.id === ID; })) { render(cached); return; }
    // no-store：不用瀏覽器的 HTTP 快取（worker 回應帶 max-age=60，給 Cloudflare 用的）；快取由擴充自己的 announcementFeed 管，
    // 不然 announcementReset() 清掉之後重抓，還是會拿到瀏覽器存著的舊回應
    fetch(api + ANNOUNCE_PATH, { credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.items)) throw new Error("bad");
        chrome.storage.local.set({ announcementFeed: { v: ANNOUNCE_FEED_V, at: Date.now(), api: api, items: j.items } });
        render(j.items);
      })
      .catch(function () { render(cached); });
  });
});

// Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") {
  globalThis.__BCS_TEST__.register("announcement", { render: render, renderLottery: renderLottery, renderHtml: renderHtml, openLink: openLink, pickLang: pickLang, uiLangCode: uiLangCode, ID: ID });
}
