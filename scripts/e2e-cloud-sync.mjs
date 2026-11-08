// 雲端備份的端對端測試：用 Chrome for Testing（puppeteer）載入 src/，打 staging 後台（api-staging.biboost.app）。
//   npm run e2e:cloud [-- --only on|off] [--headful] [--out <截圖資料夾>]
//
// 功能開關不看 staging 資料庫：攔截擴充對 /v1/features 的請求，回本機用 FEATURES_SIGNING_KEY（.env.local）簽的開／關。
// Google 登入畫面沒辦法自動化（要真的 Google 帳號），所以：
//   · 只驗到「點登入 → 後台 start → Google 授權頁」這段，並檢查 Google 沒回 redirect_uri_mismatch 之類的錯誤
//   · 登入後的流程用 staging 的驗證碼登入（DEV_EXPOSE_CODE）拿 token，寫進擴充的 cloudAccount，等同登入完成
// 測試帳號：E2E_EMAIL（預設 e2e-extension@example.com）；每次開始先清空它在雲端的備份。
//
// 開啟（on）：歡迎頁直接有雲端備份面板 → Google 授權頁沒錯 → 登入後面板換成帳號 → A 手動備份 → B 全新安裝後還原
//            → 兩台打開自動同步、互相改設定（含節點與國家）都會同步過去 → 登出
// 關閉（off）：全新安裝不開歡迎頁、popup 沒有雲端備份按鈕、直接開歡迎頁也沒有面板
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
  return signJws({ iat: Math.floor(Date.now() / 1000), features: { cloud_sync: { enabled: on, tier: "basic" } } }, SIGNING_KEY);
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
    await sleep(6000);
    const welcome = await c.findPage("welcome.html", 500);
    check("全新安裝不開歡迎頁", !welcome);
    const pop = await c.page("popup.html");
    await sleep(2500);
    await c.shot(pop, "popup");
    check("popup 首頁沒有「雲端備份」按鈕", !(await visible(pop, "#cloudBtn")));
    check("popup 進階設定沒有「雲端備份」按鈕", !(await pop.$eval("#cloudAdvBtn", (e) => e.style.display !== "none").catch(() => false)));
    const w = await c.page("welcome.html");
    await sleep(2000);
    await c.shot(w, "welcome");
    check("直接開歡迎頁也沒有雲端備份面板", !(await visible(w, "#cloudPanel")) && !(await w.$(".bbcCard")));
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
  try {
    // 1. 歡迎頁
    const wa = await A.findPage("welcome.html");
    if (!check("全新安裝自動開歡迎頁", wa)) return;
    await wa.waitForSelector("#cloudPanel .bbcBtn.google", { timeout: 15000 }).catch(() => {});
    await A.shot(wa, "1-welcome");
    check("歡迎頁直接顯示雲端備份說明", (await text(wa, "#cloudPanel .bbcText")).length > 10, await text(wa, "#cloudPanel .bbcText"));
    check("歡迎頁直接有「使用 Google 登入」", await visible(wa, "#cloudPanel .bbcBtn.google"));

    // 2. Google 登入：開新分頁 → 後台 start → Google 授權頁（不能有 redirect_uri_mismatch）
    await wa.click("#cloudPanel .bbcBtn.google");
    const gt = await A.browser.waitForTarget((t) => t.type() === "page" && /accounts\.google\.com/.test(t.url()), { timeout: 20000 }).catch(() => null);
    if (check("點登入會開到 Google 授權頁", gt)) {
      const gp = await gt.page();
      await gp.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      await A.shot(gp, "2-google");
      const u = new URL(gp.url());
      const body = await gp.evaluate(() => document.body.innerText).catch(() => "");
      const redirect = u.searchParams.get("redirect_uri") || new URLSearchParams(u.searchParams.get("continue") ? new URL(u.searchParams.get("continue")).search : "").get("redirect_uri") || "";
      check("Google 授權頁沒有錯誤（redirect_uri 有登記）", !/redirect_uri_mismatch|invalid_request|Error 400|錯誤 400|发生错误|Access blocked|已封鎖存取權/i.test(body),
        /redirect_uri_mismatch/.test(body) ? `redirect_uri_mismatch：Google OAuth client 沒登記 ${redirect || API + "/auth/oauth/google/callback"}` : redirect);
      await gp.close();
    }
    const pend = await A.storage("cloudAuthPending");
    check("登入前先存好 state 與 PKCE verifier", pend.cloudAuthPending && pend.cloudAuthPending.state && pend.cloudAuthPending.verifier);

    // 3. 登入完成（staging 驗證碼登入的 token）→ 面板自己換成帳號
    await settled(A);
    await A.setStorage({ cloudAccount: account });
    check("登入後歡迎頁面板換成帳號", await until(async () => (await text(wa, "#cloudPanel .bbcEmail")).includes(EMAIL), 10000));
    await A.shot(wa, "3-signed-in");
    const pa = await A.page("popup.html");
    await sleep(1500);
    check("popup 首頁有「雲端備份」按鈕", await visible(pa, "#cloudBtn"));
    await pa.click("#cloudBtn");
    check("popup 的雲端備份視窗顯示帳號", await until(async () => (await text(pa, ".bbcMask .bbcEmail")).includes(EMAIL), 10000));
    await A.shot(pa, "3-popup-modal");
    await pa.close();

    // 4. A 改設定 → 手動備份
    const settingsA = { showDebug: true, uiTheme: "dark", stVideoSec: 7, customHosts: ["upos-sz-mirrorcos.bilivideo.com"], cdnCountry: "JP", cdnHost: "upos-sz-mirrorakam.akamaized.net" };
    await A.setStorage(settingsA);
    const r1 = await panelAction(wa, "#cloudPanel .bbcBtn:not(.alt):not(.google)");
    check("A「備份到雲端」成功", r1 === "done", r1);
    const ext1 = await cloudData(token, "extension"), sh1 = await cloudData(token, "shared");
    check("雲端有 A 的設定（含節點與國家）", ext1.showDebug === true && ext1.uiTheme === "dark" && ext1.stVideoSec === 7 && ext1.cdnCountry === "JP" && ext1.cdnHost === settingsA.cdnHost,
      JSON.stringify({ showDebug: ext1.showDebug, uiTheme: ext1.uiTheme, stVideoSec: ext1.stVideoSec, cdnCountry: ext1.cdnCountry, cdnHost: ext1.cdnHost }));
    check("自訂節點放在共用區（跟 App 共用）", JSON.stringify(sh1.customHosts) === JSON.stringify(settingsA.customHosts), JSON.stringify(sh1.customHosts));

    // 5. B（另一台）全新安裝 → 還原
    B = await machine("B", true);
    const wb = await B.findPage("welcome.html");
    check("B 全新安裝也開歡迎頁", wb);
    await settled(B);
    await B.setStorage({ cloudAccount: account });
    await until(async () => (await text(wb, "#cloudPanel .bbcEmail")).includes(EMAIL), 10000);
    const r2 = await panelAction(wb, "#cloudPanel .bbcBtn.alt");
    check("B「從雲端同步到本地」成功", r2 === "done", r2);
    await B.shot(wb, "5-restored");
    const sb = await B.storage(null);
    const same = Object.keys(settingsA).filter((k) => JSON.stringify(sb[k]) !== JSON.stringify(settingsA[k]));
    check("B 的設定跟 A 一樣（含節點與國家）", !same.length, same.length ? `不同：${same.join("、")}` : "");
    check("還原後 B 不再被當成新使用者", sb.countryAutoDone === true && sb.installTestPending === false);

    // 6. 自動同步：兩台都在面板打開
    for (const [m, p] of [[A, wa], [B, wb]]) {
      await until(async () => p.$("#cloudPanel .bbcAuto input"), 10000);
      await p.click("#cloudPanel .bbcAuto input");
      check(`${m.name} 打開自動同步`, await until(async () => (await m.storage("cloudSync")).cloudSync?.auto === true, 10000));
    }
    await A.setStorage({ stVideoSec: 9, cdnCountry: "HK", cdnHost: "upos-sz-mirrorali.bilivideo.com" });
    const up = await until(async () => { const d = await cloudData(token, "extension"); return d.stVideoSec === 9 && d.cdnHost === "upos-sz-mirrorali.bilivideo.com" ? d : null; }, 20000, 1000);
    check("A 改設定（含切換節點）約 2 秒後自動上傳", up);
    const pb = await B.page("popup.html"); // 打開 popup 會拉一次
    const down = await until(async () => { const s = await B.storage(["stVideoSec", "cdnCountry", "cdnHost"]); return s.stVideoSec === 9 && s.cdnCountry === "HK" && s.cdnHost === "upos-sz-mirrorali.bilivideo.com" ? s : null; }, 20000, 1000);
    check("B 打開 popup 就拉到 A 的改動（含節點與國家）", down, down ? "" : JSON.stringify(await B.storage(["stVideoSec", "cdnCountry", "cdnHost"])));
    await B.shot(pb, "6-popup-synced");
    await pb.close();
    await B.setStorage({ uiTheme: "light", customHosts: ["upos-sz-mirrorcos.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com"] });
    await until(async () => (await cloudData(token, "extension")).uiTheme === "light", 20000, 1000);
    const pa2 = await A.page("popup.html");
    const back = await until(async () => { const s = await A.storage(["uiTheme", "customHosts"]); return s.uiTheme === "light" && (s.customHosts || []).length === 2 ? s : null; }, 20000, 1000);
    check("反過來 B 的改動也同步到 A（含共用的自訂節點）", back);
    await pa2.close();
    const errs = [(await A.storage("cloudSync")).cloudSync?.lastErr, (await B.storage("cloudSync")).cloudSync?.lastErr].filter(Boolean);
    check("自動同步沒有錯誤", !errs.length, errs.join("、"));

    // 7. 登出
    await clickPanel(wa, "#cloudPanel .bbcLogout");
    check("A 登出後面板回到「使用 Google 登入」", await until(async () => visible(wa, "#cloudPanel .bbcBtn.google"), 10000));
    const sa = await A.storage(["cloudAccount", "cloudSync"]);
    check("A 登出後清掉帳號、關掉自動同步", !sa.cloudAccount && sa.cloudSync && sa.cloudSync.auto === false);
    check("登出後 token 在後台作廢", (await api("GET", "/me", undefined, token)).status === 401);
    await A.shot(wa, "7-logged-out");
  } finally {
    await A.close();
    if (B) await B.close();
  }
}

try {
  if (!ONLY || ONLY === "off") await scenarioOff();
  if (!ONLY || ONLY === "on") await scenarioOn();
} catch (e) {
  check("執行過程沒有例外", false, e.stack || String(e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過。截圖：${OUT}`);
if (failed.length) { console.log("沒過："); failed.forEach((r) => console.log(`  [${r.scenario}] ${r.name}${r.detail ? `：${r.detail}` : ""}`)); }
process.exit(failed.length ? 1 : 0);
