// 雲端備份的端對端測試：用 Chrome for Testing（puppeteer）載入 src/，打 staging 後台（api-staging.biboost.app）。
//   npm run e2e:cloud [-- --only on|off|locked] [--headful] [--out <截圖資料夾>]
//
// 功能開關不看 staging 資料庫：攔截擴充對 /v1/features 的請求，回本機用 FEATURES_SIGNING_KEY（.env.local）簽的開／關。
// Google 登入畫面沒辦法自動化（要真的 Google 帳號），所以：
//   · 只驗到「點登入 → 後台 start → Google 授權頁」這段，並檢查 Google 沒回 redirect_uri_mismatch 之類的錯誤
//   · 登入後的流程用 staging 的驗證碼登入（DEV_EXPOSE_CODE）拿 token，寫進擴充的 cloudAccount，等同登入完成
// 測試帳號：E2E_EMAIL（預設 e2e-extension@example.com）；每次開始先清空它在雲端的備份。
//
// 開啟（on）：歡迎頁（小視窗）有動畫與雲端備份面板 → 在同一個視窗換到 Google 授權頁（沒錯誤）→ 登入失敗可返回 → 登入後只有「從雲端恢復設定」「取消」
//            → 取消關掉視窗 → 設定頁卡片（灰／綠）、視窗兩顆按鈕一樣且滑過變色 → A 備份 → B 歡迎頁恢復後視窗自己關掉
//            → 兩台打開自動同步：改設定（含節點與國家）會自動上傳、但不會蓋掉另一台，另一台手動恢復才拿到 → 登出 → 從 popup 登入開小視窗
// 關閉（off）：全新安裝照樣開歡迎頁，但只有歡迎詞與「開始使用」；popup 沒有雲端備份按鈕與設定卡片
// 進階（locked）：功能開著但等級是進階、沒有會員資格：popup 的按鈕灰掉加鎖頭（private/ 的模組），歡迎頁不放雲端備份
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { signJws } from "../tools/report-worker/src/features.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api-staging.biboost.app";
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const ONLY = opt("--only");
const HEADFUL = argv.includes("--headful");
const OUT = path.resolve(opt("--out") || path.join(os.tmpdir(), "biboost-e2e-cloud"));
const EMAIL = process.env.E2E_EMAIL || "e2e-extension@example.com";
fs.mkdirSync(OUT, { recursive: true });

function envLocal(key) {
  const line = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).find((l) => l.startsWith(key + "="));
  if (!line) throw new Error(`.env.local 沒有 ${key}`);
  return line.slice(key.length + 1).trim().replace(/^'(.*)'$/, "$1");
}
const SIGNING_KEY = envLocal("FEATURES_SIGNING_KEY");

// ---- 結果 ----
const results = [];
let current = "";
function check(name, ok, detail) {
  results.push({ scenario: current, name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? `  （${detail}）` : ""}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 300) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
    await sleep(step);
  }
  return last;
}

// ---- 後台 ----
async function api(method, p, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function loginToken() {
  const s = await api("POST", "/auth/start", { email: EMAIL });
  if (!s.json.devCode) throw new Error(`拿不到驗證碼：${s.status} ${JSON.stringify(s.json)}（一分鐘內只能要一次）`);
  const v = await api("POST", "/auth/verify", { email: EMAIL, code: s.json.devCode });
  if (!v.json.token) throw new Error(`驗證碼登入失敗：${v.status} ${JSON.stringify(v.json)}`);
  return v.json.token;
}
async function clearCloud(token) {
  const all = (await api("GET", "/me/settings", undefined, token)).json || {};
  for (const ns of ["extension", "shared"]) {
    if (all[ns] && all[ns].rev) await api("PUT", `/me/settings/${ns}`, { data: {}, baseRev: all[ns].rev, client: "e2e" }, token);
  }
}
const cloudData = async (token, ns) => ((await api("GET", "/me/settings", undefined, token)).json[ns] || {}).data || {};

// ---- 瀏覽器 ----
async function featuresJws(on) {
  const flag = typeof on === "object" ? on : { enabled: on, tier: "basic" };
  return signJws({ iat: Math.floor(Date.now() / 1000), features: { cloud_sync: flag } }, SIGNING_KEY);
}
// 一台「電腦」：獨立的設定檔、全新安裝擴充；cloudOn 決定 /v1/features 回開或關
async function machine(name, cloudOn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `biboost-e2e-${name}-`));
  const browser = await puppeteer.launch({ headless: !HEADFUL, enableExtensions: true, userDataDir: dir, args: ["--no-first-run", "--no-default-browser-check"] });
  const cdp = await browser.target().createCDPSession();
  let flagOn = cloudOn;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${API}/v1/features*` }] });
  cdp.on("Fetch.requestPaused", async (e) => {
    const body = JSON.stringify({ ok: true, jws: await featuresJws(flagOn) });
    await cdp.send("Fetch.fulfillRequest", {
      requestId: e.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(body).toString("base64"),
    }).catch(() => {});
  });
  const id = await browser.installExtension(path.join(ROOT, "src"));
  const base = `chrome-extension://${id}/`;
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(base), { timeout: 15000 });
  const m = {
    name, browser, id, base, dir,
    setFlag(on) { flagOn = on; },
    async sw() { const t = await browser.waitForTarget((x) => x.type() === "service_worker" && x.url().startsWith(base), { timeout: 15000 }); return t.worker(); },
    async storage(keys) { return (await m.sw()).evaluate((k) => chrome.storage.local.get(k), keys ?? null); },
    async setStorage(obj) { return (await m.sw()).evaluate((o) => chrome.storage.local.set(o), obj); },
    async page(file) { const p = await browser.newPage(); await p.goto(base + file); return p; },
    async findPage(suffix, ms = 15000) {
      const t = await browser.waitForTarget((x) => x.type() === "page" && x.url().startsWith(base + suffix), { timeout: ms }).catch(() => null);
      return t ? t.page() : null;
    },
    async shot(p, label) { await p.screenshot({ path: path.join(OUT, `${current}-${name}-${label}.png`) }).catch(() => {}); },
    async close() { await browser.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  void swTarget;
  return m;
}
const visible = (p, sel) => p.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)).catch(() => false);
const text = (p, sel) => p.$eval(sel, (e) => e.textContent.trim()).catch(() => "");
async function clickPanel(p, sel) { await p.waitForSelector(sel, { timeout: 15000 }); await p.click(sel); }
// 面板按鈕按下去 → 等打勾動畫（.bbcDone）或錯誤（.bbcErr）
async function panelAction(p, sel) {
  await clickPanel(p, sel);
  const r = await until(async () => (await p.$(".bbcDone")) ? "done" : (await text(p, ".bbcErr")) || null, 20000);
  return r;
}
// 國家偵測（全新安裝依 IP 選國家）跑完再動設定，免得它晚一步蓋掉
const settled = (m) => until(async () => { const s = await m.storage(["cdnHost", "countryAutoDone"]); return s.cdnHost ? s : null; }, 20000);

// ---- 情境：功能關閉 ----
async function scenarioOff() {
  current = "off";
  console.log("\n【功能關閉】");
  const c = await machine("C", false);
  try {
    const w = await c.findPage("welcome.html");
    check("全新安裝照樣開歡迎頁", w);
    await sleep(3000);
    await c.shot(w, "welcome");
    check("歡迎頁有歡迎詞與「開始使用」", (await text(w, "#welcomeTitle")).length > 3 && await visible(w, "#startBtn"));
    check("歡迎頁沒有雲端備份面板", !(await visible(w, "#cloudPanel")) && !(await w.$(".bbcCard")));
    const pop = await c.page("popup.html");
    await sleep(2500);
    await c.shot(pop, "popup");
    check("popup 首頁沒有「雲端備份」按鈕", !(await visible(pop, "#cloudBtn")));
    check("popup 設定頁沒有「雲端備份」卡片", !(await pop.$eval("#cloudAdvItem", (e) => e.style.display !== "none").catch(() => false)));
  } finally { await c.close(); }
}

// ---- 情境：功能開著，但等級是進階、沒有會員資格（鎖頭由 src/private/ 的模組畫）----
async function scenarioLocked() {
  current = "locked";
  console.log("\n【進階等級、沒有資格】");
  const hasPrivate = fs.existsSync(path.join(ROOT, "src/private/guard.js"));
  if (!check("有 src/private/（鎖頭模組）", hasPrivate, hasPrivate ? "" : "公開 repo 沒有這個資料夾，略過")) return;
  const c = await machine("L", { enabled: true, tier: "premium" });
  try {
    const w = await c.findPage("welcome.html");
    await sleep(3000);
    await c.shot(w, "welcome");
    check("歡迎頁不放雲端備份", !(await visible(w, "#cloudPanel")));
    const pop = await c.page("popup.html");
    const locked = await until(async () => pop.$eval("#cloudBtn", (e) => e.classList.contains("bb-locked") && !!e.querySelector(".bb-lock-badge")).catch(() => false), 10000);
    await c.shot(pop, "popup");
    check("popup 首頁的「雲端備份」灰掉加鎖頭", locked);
    await pop.click("#cloudBtn");
    await sleep(500);
    check("點了不開雲端備份視窗，改開說明", !(await pop.$(".bbcMask")) && await visible(pop, ".bb-lock-dialog"));
    await c.shot(pop, "popup-dialog");
    const adv = await pop.$eval("#cloudAdvBtn", (e) => e.classList.contains("bb-locked")).catch(() => false);
    check("設定頁卡片的「管理」也鎖住", adv);
  } finally { await c.close(); }
}

// ---- 情境：功能開啟 ----
async function scenarioOn() {
  current = "on";
  console.log("\n【功能開啟】");
  const token = await loginToken();
  await clearCloud(token);
  const account = { api: API, token, email: EMAIL };
  const A = await machine("A", true);
  let B = null;
  // popup 打開雲端備份視窗（首頁的按鈕）
  async function popupModal(m) {
    const p = await m.page("popup.html");
    await p.waitForSelector("#cloudBtn", { visible: true, timeout: 15000 });
    await p.click("#cloudBtn");
    await p.waitForSelector(".bbcMask .bbcBtn", { timeout: 15000 });
    return p;
  }
  const closed = (p, ms = 8000) => until(async () => p.isClosed(), ms, 200);
  try {
    // 1. 歡迎頁（小視窗）：動畫、大大的歡迎詞與賣點（沒有三步驟），雲端備份（Google 登入／稍後再說，上下排），最下面「開始使用」
    const wa = await A.findPage("welcome.html");
    if (!check("全新安裝自動開歡迎頁", wa)) return;
    await wa.waitForSelector("#cloudPanel .bbcBtn.google", { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    await A.shot(wa, "1-welcome");
    check("歡迎頁是小視窗（不是分頁）", await wa.evaluate(() => new Promise((r) => chrome.windows.getCurrent((w) => r(w.type)))) === "popup");
    check("歡迎頁有開場動畫（圖示＋眼睛）", await wa.$("#hero svg.wh .eye") !== null);
    check("歡迎頁有大標題與賣點、沒有三步驟", (await text(wa, "#welcomeTitle")).length > 3 && (await text(wa, "#welcomeBody")).length > 5 && !(await wa.$(".tips")));
    check("歡迎頁直接顯示雲端備份說明", (await text(wa, "#cloudPanel .bbcText")).length > 10, await text(wa, "#cloudPanel .bbcText"));
    const loginBtns = await wa.$$eval("#cloudPanel .bbcBtn", (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), top: r.top }; }));
    check("未登入：「使用 Google 登入」在上、「稍後再說」在下", loginBtns.length === 2 && loginBtns[1].top > loginBtns[0].top && (await visible(wa, "#cloudPanel .bbcBtn.google")), loginBtns.map((b) => b.t).join("／"));
    check("最下面有主按鈕「開始使用」", await visible(wa, "#startBtn"));
    // puppeteer 預設把頁面設成 800×600：換成歡迎視窗真正的內容大小（500×700 的視窗扣掉標題列）再量
    await wa.setViewport({ width: 500, height: 660 });
    await sleep(300);
    await A.shot(wa, "1-welcome-500");
    const fits = await wa.evaluate(() => { const b = document.getElementById("startBtn").getBoundingClientRect(); return b.bottom <= window.innerHeight; });
    check("不用捲動就看得到「開始使用」", fits);

    // 2. Google 登入：在同一個視窗換頁到 Google 授權頁（不能有 redirect_uri_mismatch），不另開分頁
    const pagesBefore = (await A.browser.pages()).length;
    await wa.click("#cloudPanel .bbcBtn.google");
    const onGoogle = await until(async () => /accounts\.google\.com/.test(wa.url()), 20000);
    if (check("點登入在同一個視窗換到 Google 授權頁", onGoogle, wa.url())) {
      await wa.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      await A.shot(wa, "2-google");
      const body = await wa.evaluate(() => document.body.innerText).catch(() => "");
      check("Google 授權頁沒有錯誤（redirect_uri 有登記）", !/redirect_uri_mismatch|invalid_request|Error 400|錯誤 400|发生错误|Access blocked|已封鎖存取權/i.test(body));
    }
    check("登入沒有多開分頁或視窗", (await A.browser.pages()).length === pagesBefore);
    const pend = (await A.storage("cloudAuthPending")).cloudAuthPending;
    check("登入前先存好 state、PKCE verifier 與要回去的歡迎頁", pend && pend.state && pend.verifier && pend.back === "welcome.html", JSON.stringify(pend && pend.back));
    // Google 那頭沒辦法自動化：先驗「登入失敗」會給一顆「返回」回到歡迎頁
    await wa.goto(A.base + "auth.html?error=access_denied&state=x");
    await wa.waitForSelector(".authBack", { timeout: 10000 }).catch(() => {});
    await A.shot(wa, "2-auth-fail");
    await wa.click(".authBack").catch(() => {});
    check("登入失敗按「返回」回到歡迎頁", await until(async () => wa.url().startsWith(A.base + "welcome.html"), 10000), wa.url());

    // 3. 登入完成（staging 驗證碼登入的 token）。auth.html 成功時會換回 welcome.html，這裡直接寫帳號再回到歡迎頁
    await settled(A);
    await A.setStorage({ cloudAccount: account });
    await wa.goto(A.base + "welcome.html");
    check("登入後歡迎頁面板換成帳號", await until(async () => (await text(wa, "#cloudPanel .bbcEmail")).includes(EMAIL), 10000));
    await sleep(1200);
    await A.shot(wa, "3-signed-in");
    check("登入後不再顯示歡迎的部分", !(await visible(wa, "#welcomeHero")));
    check("登入後沒有自動同步開關、沒有登出、沒有取消", !(await wa.$("#cloudPanel .bbcAuto")) && !(await wa.$("#cloudPanel .bbcLogout")) && !(await wa.$("#cloudPanel .bbcCancel")));
    check("雲端沒有備份：不問要不要恢復，只寫雲端還沒有備份", await until(async () => !(await visible(wa, "#cloudPanel .bbcAsk")) && (await text(wa, "#cloudPanel .bbcMeta")).length > 0, 8000), await text(wa, "#cloudPanel .bbcMeta"));
    await wa.click("#startBtn");
    check("按「開始使用」就關掉歡迎頁", await closed(wa));
    const popT = await A.browser.waitForTarget((t) => t.url() === A.base + "popup.html", { timeout: 5000 }).catch(() => null);
    check("按「開始使用」會打開擴充的 popup 一次", popT, popT ? "" : "沒看到 popup（無頭瀏覽器可能不支援 action.openPopup）");
    if (popT) { const pp = await popT.page().catch(() => null); if (pp) await pp.close().catch(() => {}); }

    // 4. 設定頁：雲端備份卡片在 debug 疊層上面，顯示自動同步沒開（灰色）
    const settingsA = { showDebug: true, uiTheme: "dark", stVideoSec: 7, customHosts: ["upos-sz-mirrorcos.bilivideo.com"], cdnCountry: "JP", cdnHost: "upos-sz-mirrorakam.akamaized.net" };
    await A.setStorage(settingsA);
    let pa = await A.page("popup.html");
    await pa.waitForSelector("#cloudAdvItem", { timeout: 15000 });
    await pa.evaluate(() => document.getElementById("gearBtn").click());
    await sleep(800);
    const card = await pa.evaluate(() => {
      const item = document.getElementById("cloudAdvItem");
      return { shown: item.style.display !== "none", aboveDebug: !!(item.nextElementSibling && item.nextElementSibling.querySelector("#showDebug")),
        btn: document.getElementById("cloudAdvBtn").textContent, on: document.getElementById("cloudState").classList.contains("on"), state: document.getElementById("cloudStateText").textContent,
        who: document.getElementById("cloudWho").textContent };
    });
    await pa.evaluate(() => document.getElementById("cloudAdvItem").scrollIntoView({ block: "center" }));
    await sleep(200);
    await A.shot(pa, "4-settings-card");
    check("設定頁有雲端備份卡片，在 debug 疊層上面", card.shown && card.aboveDebug, JSON.stringify(card));
    check("卡片左邊是登入的帳號", card.who === EMAIL, card.who);
    check("卡片右邊是灰色的「自動同步」", !card.on && card.state.length > 0 && card.state.length <= 8, card.state);
    await pa.click("#cloudAdvBtn");
    await pa.waitForSelector(".bbcMask .bbcBtn", { timeout: 15000 });
    await until(async () => (await text(pa, ".bbcMask .bbcEmail")).includes(EMAIL), 10000);
    // 兩顆按鈕一樣、滑過會變色（先把滑鼠移開、等變色過渡結束，免得剛好停在其中一顆上）
    await pa.mouse.move(1, 1);
    await sleep(400);
    const look = await pa.$$eval(".bbcMask .bbcBtn", (bs) => bs.map((b) => { const s = getComputedStyle(b); return s.backgroundColor + "|" + s.borderColor + "|" + s.color + "|" + s.fontWeight; }));
    check("視窗裡「備份到雲端」「從雲端恢復設定」樣式一樣（沒有主按鈕）", look.length === 2 && look[0] === look[1], look.join(" vs "));
    await pa.hover(".bbcMask .bbcBtn");
    await sleep(300);
    const hov = await pa.$eval(".bbcMask .bbcBtn", (b) => { const s = getComputedStyle(b); return s.backgroundColor + "|" + s.borderColor + "|" + s.color + "|" + s.fontWeight; });
    check("滑過按鈕會變色", hov !== look[0], hov);
    await A.shot(pa, "4-modal-hover");
    check("自動同步沒有說明文字", !(await pa.$(".bbcMask .bbcAuto small")));
    const r1 = await panelAction(pa, ".bbcMask .bbcBtn");
    check("A「備份到雲端」成功", r1 === "done", r1);
    check("成功後視窗自己關掉", await until(async () => !(await pa.$(".bbcMask")), 5000));
    const ext1 = await cloudData(token, "extension"), sh1 = await cloudData(token, "shared");
    check("雲端有 A 的設定（含節點與國家）", ext1.showDebug === true && ext1.uiTheme === "dark" && ext1.stVideoSec === 7 && ext1.cdnCountry === "JP" && ext1.cdnHost === settingsA.cdnHost,
      JSON.stringify({ showDebug: ext1.showDebug, uiTheme: ext1.uiTheme, stVideoSec: ext1.stVideoSec, cdnCountry: ext1.cdnCountry, cdnHost: ext1.cdnHost }));
    check("自訂節點放在共用區（跟 App 共用）", JSON.stringify(sh1.customHosts) === JSON.stringify(settingsA.customHosts), JSON.stringify(sh1.customHosts));
    await pa.close();

    // 5. B（另一台）全新安裝 → 歡迎頁「從雲端恢復設定」→ 動畫播完視窗自己關掉
    B = await machine("B", true);
    const wb = await B.findPage("welcome.html");
    check("B 全新安裝也開歡迎頁", wb);
    await settled(B);
    await B.setStorage({ cloudAccount: account });
    await until(async () => (await text(wb, "#cloudPanel .bbcEmail")).includes(EMAIL), 10000);
    check("雲端有備份：問「要從雲端恢復設定嗎？」", await until(async () => visible(wb, "#cloudPanel .bbcAsk"), 10000), await text(wb, "#cloudPanel .bbcAsk"));
    const restoreBtns = await wb.$$eval("#cloudPanel .bbcBtn", (bs) => bs.map((b) => b.className + ":" + b.textContent.trim()));
    check("只有一顆主色的「從雲端恢復」", restoreBtns.length === 1 && /primary/.test(restoreBtns[0]), restoreBtns.join("／"));
    await wb.setViewport({ width: 500, height: 660 });
    await sleep(500);
    await B.shot(wb, "5-welcome-restore");
    const r2 = await panelAction(wb, "#cloudPanel .bbcBtn.primary");
    check("B「從雲端恢復設定」成功", r2 === "done", r2);
    check("恢復完歡迎頁自己關掉", await closed(wb));
    const sb = await B.storage(null);
    const same = Object.keys(settingsA).filter((k) => JSON.stringify(sb[k]) !== JSON.stringify(settingsA[k]));
    check("B 的設定跟 A 一樣（含節點與國家）", !same.length, same.length ? `不同：${same.join("、")}` : "");
    check("還原後 B 不再被當成新使用者", sb.countryAutoDone === true && sb.installTestPending === false);

    // 6. 自動同步（單向）：在 popup 的視窗打開；設定頁卡片變綠勾。本機一改就上傳，不會把雲端的改動拉回別台
    for (const m of [A, B]) {
      const p = await popupModal(m);
      await p.waitForSelector(".bbcMask .bbcAuto input", { timeout: 10000 });
      await p.click(".bbcMask .bbcAuto input");
      check(`${m.name} 打開自動同步`, await until(async () => (await m.storage("cloudSync")).cloudSync?.auto === true, 10000));
      await p.click(".bbcMask .bbcClose");
      const on = await until(async () => p.$eval("#cloudState", (e) => e.classList.contains("on")), 5000);
      check(`${m.name} 設定頁卡片變成綠色打勾（自動同步已開啟）`, on, await text(p, "#cloudStateText"));
      if (m === A) { await p.evaluate(() => { document.getElementById("gearBtn").click(); document.getElementById("cloudAdvItem").scrollIntoView({ block: "center" }); }); await sleep(600); await A.shot(p, "6-card-on"); }
      await p.close();
    }
    await A.setStorage({ stVideoSec: 9, cdnCountry: "HK", cdnHost: "upos-sz-mirrorali.bilivideo.com" });
    const up = await until(async () => { const d = await cloudData(token, "extension"); return d.stVideoSec === 9 && d.cdnHost === "upos-sz-mirrorali.bilivideo.com" ? d : null; }, 20000, 1000);
    check("A 改設定（含切換節點）約 2 秒後自動上傳", up);
    const pb = await B.page("popup.html");
    await sleep(4000);
    const still = await B.storage(["stVideoSec", "cdnCountry"]);
    check("B 不會自動被雲端蓋掉（打開 popup 也不拉）", still.stVideoSec === 7 && still.cdnCountry === "JP", JSON.stringify(still));
    await pb.click("#cloudBtn");
    await pb.waitForSelector(".bbcMask .bbcBtn", { timeout: 15000 });
    const r3 = await panelAction(pb, ".bbcMask .bbcBtn:nth-of-type(2)");
    check("B 在 popup 按「從雲端恢復設定」拿到 A 的改動", r3 === "done", r3);
    const shown = await until(async () => (await pb.$eval("#countrySelect", (e) => e.value).catch(() => "")) === "HK", 10000, 500);
    check("同一個 popup 畫面直接顯示還原的國家", shown, shown ? "" : await pb.$eval("#countrySelect", (e) => e.value).catch(() => "?"));
    await B.shot(pb, "6-popup-restored");
    await pb.close();
    await B.setStorage({ uiTheme: "light", customHosts: ["upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com"] });
    const upB = await until(async () => { const e = await cloudData(token, "extension"), sh = await cloudData(token, "shared"); return e.uiTheme === "light" && (sh.customHosts || []).length === 2; }, 20000, 1000);
    check("B 的改動也自動上傳（含共用的自訂節點）", upB);
    const sa0 = await A.storage(["uiTheme", "customHosts"]);
    check("A 不會自動被 B 的改動蓋掉", sa0.uiTheme === "dark" && (sa0.customHosts || []).length === 1, JSON.stringify(sa0));
    const errs = [(await A.storage("cloudSync")).cloudSync?.lastErr, (await B.storage("cloudSync")).cloudSync?.lastErr].filter(Boolean);
    check("自動同步沒有錯誤", !errs.length, errs.join("、"));

    // 7. 登出 → 從 popup 登入：開一個小視窗到 Google（不是分頁）
    pa = await popupModal(A);
    await until(async () => pa.$(".bbcMask .bbcLogout"), 10000);
    await pa.click(".bbcMask .bbcLogout");
    check("A 登出後視窗回到「使用 Google 登入」", await until(async () => visible(pa, ".bbcMask .bbcBtn.google"), 10000));
    const sa = await A.storage(["cloudAccount", "cloudSync"]);
    check("A 登出後清掉帳號、關掉自動同步", !sa.cloudAccount && sa.cloudSync && sa.cloudSync.auto === false);
    check("登出後 token 在後台作廢", (await api("GET", "/me", undefined, token)).status === 401);
    check("登出後設定頁卡片回到灰色", await until(async () => !(await pa.$eval("#cloudState", (e) => e.classList.contains("on"))), 5000));
    await pa.click(".bbcMask .bbcBtn.google");
    const gt = await A.browser.waitForTarget((t) => t.type() === "page" && /accounts\.google\.com/.test(t.url()), { timeout: 20000 }).catch(() => null);
    if (check("從 popup 登入會開到 Google 授權頁", gt)) {
      const gp = await gt.page();
      const wins = await (await A.sw()).evaluate(() => new Promise((r) => chrome.windows.getAll({ populate: true }, (ws) => r(ws.map((w) => ({ type: w.type, urls: w.tabs.map((t) => t.url || t.pendingUrl) }))))));
      // 擴充沒有 tabs 權限，看不到網址；歡迎頁已經關掉，這時唯一的小視窗就是登入視窗
      check("從 popup 登入開的是小視窗", wins.filter((w) => w.type === "popup").length === 1, JSON.stringify(wins.map((w) => w.type)));
      await gp.close();
    }
    check("從 popup 登入不記要回去的頁面", !((await A.storage("cloudAuthPending")).cloudAuthPending || {}).back);
    // 從 popup 登入失敗：只有一顆「關閉」
    const af = await A.page("auth.html?error=access_denied&state=x");
    await af.waitForSelector(".authBack", { timeout: 10000 }).catch(() => {});
    check("從 popup 登入失敗時按鈕是「關閉」", (await text(af, ".authBack")).length > 0, await text(af, ".authBack"));
    await af.click(".authBack");
    check("按「關閉」關掉登入視窗", await closed(af));
    await pa.close().catch(() => {});
  } finally {
    await A.close();
    if (B) await B.close();
  }
}

try {
  if (!ONLY || ONLY === "off") await scenarioOff();
  if (!ONLY || ONLY === "locked") await scenarioLocked();
  if (!ONLY || ONLY === "on") await scenarioOn();
} catch (e) {
  check("執行過程沒有例外", false, e.stack || String(e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過。截圖：${OUT}`);
if (failed.length) { console.log("沒過："); failed.forEach((r) => console.log(`  [${r.scenario}] ${r.name}${r.detail ? `：${r.detail}` : ""}`)); }
process.exit(failed.length ? 1 : 0);
