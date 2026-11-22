// 問卷與匿名統計的端對端測試：用 Chrome for Testing（puppeteer）載入 src/，打 staging 後台（api-staging.biboost.app），頁面是真的 bilibili.com。
//   npm run e2e:survey [-- --only invite|none|quiet|today|announcement|blocked] [--headful] [--out <截圖資料夾>] [--survey <問卷 id>]
//
// 問卷照 staging 後台（report worker 的 /v2/surveys）進行中的問卷；需要 staging 有一份發布中、參加頁面邀請與 region_blocked 事件的問卷（SURVEY_ID）。
// 「沒有問卷」的情境攔截 /v2/surveys 回空清單。會在 staging 的 survey_responses、survey_events 留下測試資料（country 是你目前的 IP）。
//
// 情境：
//   invite       首頁停留約 5 秒出現頁面邀請 → 版面（蓋滿視窗、在最上層、頁首有標題）→ 從頭答到送出（打勾動畫後自動關、填過的紀錄進 storage.sync）
//                → 再從公告連結打開：照樣能重填（空白、同一個 responseId），送出後 doneAt 更新
//   none         伺服器沒有問卷：首頁等 12 秒，什麼都不出現
//   quiet        新安裝 3 天內／歡迎視窗還開著：首頁等 12 秒，什麼都不出現，也沒有記下出現過
//   today        出現後沒按 × 也沒填完就重新整理：今天不再出現
//   announcement 網址帶 #bb-survey=<id> 直接打開（公告連結／新分頁的情況），hash 被拿掉；× 與 Esc 關閉，按 × 記下關掉
//   blocked      真的打開一集從目前 IP 看不了的番劇（不攔截）→ 計數請求送出 → 出現事件觸發的問卷（說明文字不同）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api-staging.biboost.app";
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
// 要測的問卷：staging 進行中的那份，用 --survey <id> 指定
const SURVEY_ID = opt("--survey");
if (!SURVEY_ID) { console.error("用 --survey <id> 指定要測的問卷（staging 進行中的那份）"); process.exit(2); }
// 按 × 或 Esc 關掉問卷後的提示（六語）
const CLOSED_RE = /不會再出現|唔會再出現|不会再出现|won't show up again|表示されません|표시되지 않습니다/;
const ONLY = opt("--only");
const HEADFUL = argv.includes("--headful");
const OUT = path.resolve(opt("--out") || path.join(os.tmpdir(), "biboost-e2e-survey"));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let current = "";
function check(name, ok, detail) {
  results.push({ scenario: current, name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? `  （${detail}）` : ""}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = null; }
    await sleep(step);
  }
  return last;
}

// opts.noSurvey：攔截 /v2/surveys 回空清單（伺服器沒有問卷）；opts.fresh：保留全新安裝的狀態（installedAt＝現在，冷靜期中）；opts.keepWelcome：不關歡迎視窗
// 其他情境把 installedAt 往前調 4 天（過了新安裝的 3 天冷靜期），並關掉歡迎視窗
async function machine(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `biboost-e2e-survey-${name}-`));
  const browser = await puppeteer.launch({
    headless: !HEADFUL, enableExtensions: true, userDataDir: dir, defaultViewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
  });
  if (opts.noSurvey) {
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${API}/v2/surveys\\?*` /* CDP 的 ? 是萬用字元，要跳脫，不然會連 /v2/surveys/triggers 也攔掉 */ }] });
    cdp.on("Fetch.requestPaused", (e) => {
      cdp.send("Fetch.fulfillRequest", {
        requestId: e.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(JSON.stringify({ surveys: [] })).toString("base64"),
      }).catch(() => {});
    });
  }
  const id = await browser.installExtension(path.join(ROOT, "src"));
  const base = `chrome-extension://${id}/`;
  await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(base), { timeout: 15000 });
  const m = {
    name, browser, id, base, dir,
    async sw() { const t = await browser.waitForTarget((x) => x.type() === "service_worker" && x.url().startsWith(base), { timeout: 15000 }); return t.worker(); },
    async storage(keys) { return (await m.sw()).evaluate((k) => chrome.storage.local.get(k), keys ?? null); },
    async sync(keys) { return (await m.sw()).evaluate((k) => chrome.storage.sync.get(k), keys ?? null); },
    // 背景腳本送出的請求（頁面看不到）：在 service worker 裡包住 fetch 記下網址
    async hookFetch() { await (await m.sw()).evaluate(() => { if (globalThis.__calls) return; globalThis.__calls = []; const f = globalThis.fetch; globalThis.fetch = function (u) { globalThis.__calls.push(String(u && u.url || u)); return f.apply(this, arguments); }; }); },
    async swCalls() { return (await m.sw()).evaluate(() => globalThis.__calls || []); },
    async shot(p, label) { await p.screenshot({ path: path.join(OUT, `${current}-${label}.png`) }).catch(() => {}); },
    async close() { await browser.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  // 全新安裝會開歡迎頁（小視窗），關掉免得干擾（開著的時候問卷不會自動出現）
  await sleep(1500);
  if (!opts.keepWelcome) for (const p of await browser.pages()) if (p.url().startsWith(base)) await p.close().catch(() => {});
  if (!opts.fresh) await (await m.sw()).evaluate(() => chrome.storage.local.set({ installedAt: Date.now() - 4 * 86400000 }));
  return m;
}

// Shadow DOM 裡的東西：用 evaluate 直接查
const modal = (p) => p.evaluate(() => {
  const h = document.querySelector("[data-bb-survey]");
  if (!h) return null;
  const r = h.getBoundingClientRect(), root = h.shadowRoot;
  return { w: r.width, h: r.height, z: getComputedStyle(h).zIndex, text: root.querySelector(".card")?.textContent || "", opts: root.querySelectorAll(".opt").length, hasTitle: !!root.querySelector(".title"), top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === h,
    ok: !!root.querySelector(".okmark"), msg: root.querySelector(".msg")?.textContent || "", buttons: Array.from(root.querySelectorAll("button")).map((b) => b.textContent.trim()) };
});
const clickIn = (p, sel, nth = 0) => p.evaluate((s, n) => { const e = document.querySelector("[data-bb-survey]").shadowRoot.querySelectorAll(s)[n]; if (!e) return false; e.click(); return true; }, sel, nth);
const clickBtn = (p, label) => p.evaluate((l) => { const b = Array.from(document.querySelector("[data-bb-survey]").shadowRoot.querySelectorAll("button")).find((x) => x.textContent.trim() === l); if (!b) return false; b.click(); return true; }, label);
const btnLabels = (p) => p.evaluate(() => Array.from(document.querySelector("[data-bb-survey]")?.shadowRoot.querySelectorAll("button") || []).map((b) => b.textContent.trim()));

// 從目前這頁逐題答到最後一頁（單選點第一個；複選點第一個再按下一題），停在有「送出／略過並送出」、沒有選項的那頁
async function answerToLast(p) {
  let guard = 0;
  while (guard++ < 8) {
    const labels = await btnLabels(p);
    if (labels.some((l) => /Skip and submit|略過並送出|Submit|送出/.test(l)) && (await modal(p)).opts === 0) break;
    await clickIn(p, ".opt", 0);
    await sleep(400);
    const next = (await btnLabels(p)).find((l) => /^(Next|下一題)$/.test(l));
    if (next) await clickBtn(p, next);
    await sleep(500);
  }
}

async function open(m, url) {
  const p = await m.browser.newPage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  return p;
}

async function scenarioInvite() {
  current = "invite";
  console.log("\n【頁面邀請】");
  const m = await machine("I");
  try {
    const p = await open(m, "https://www.bilibili.com/");
    const t0 = Date.now();
    const s = await until(() => modal(p), 40000);
    check("首頁停留後出現問卷", !!s, s ? `${Math.round((Date.now() - t0) / 1000)} 秒` : "");
    if (!s) {
      await m.shot(p, "none");
      const st = await m.storage(["surveyStates", "surveyList", "surveyLastShown", "telemetrySample", "cdnListMeta"]);
      console.log("    debug storage:", JSON.stringify(st, (k, v) => (k === "jws" || k === "questions" ? "…" : v)).slice(0, 600));
      console.log("    debug page:", p.url(), "| host present:", await p.evaluate(() => !!document.querySelector("[data-bb-survey]")));
      return;
    }
    await m.shot(p, "q1");
    check("蓋滿視窗、z-index 最大、位在最上層", s.w >= 1200 && s.h >= 700 && s.z === "2147483647" && s.top, JSON.stringify({ w: s.w, h: s.h, z: s.z, top: s.top }));
    check("第 1 題有標題、說明文字與選項", /30|BiBoost/.test(s.text) && s.opts >= 2 && s.hasTitle, s.text.slice(0, 80));
    const st = await m.storage(["surveyStates", "surveyLastShown"]);
    check("記下這份問卷出現過、今天出現過", !!(st.surveyStates && st.surveyStates[SURVEY_ID] && st.surveyStates[SURVEY_ID].shownAt && st.surveyLastShown && st.surveyLastShown.id === SURVEY_ID));
    // 答到最後
    await clickIn(p, ".opt", 0); await sleep(300); await clickBtn(p, (await btnLabels(p)).find((l) => /Next|下一題/.test(l)) || "Next");
    await sleep(600);
    await m.shot(p, "q2");
    // 流程圖分岔：第 2 題選「偶爾」→ 多走兩題（總頁數變多）；回上一題改「幾乎沒有」→ 總頁數變回來，下一頁是另一題
    const count = async () => { const t = (await modal(p)).text.match(/(\d+)\/(\d+)\s*$/); return t ? [Number(t[1]), Number(t[2])] : null; };
    const before = await count();
    await clickIn(p, ".opt", 1);
    await sleep(600);
    const branch = await count();
    const branchText = (await modal(p)).text;
    check("流程圖：第 2 題選了分岔的選項，總頁數變多", before && branch && branch[0] === 3 && branch[1] > before[1], `${before && before.join("/")} → ${branch && branch.join("/")}`);
    await clickBtn(p, (await btnLabels(p)).find((l) => /^(Back|上一題)$/.test(l)) || "Back");
    await sleep(500);
    await clickIn(p, ".opt", 2); // 已經有答案：只換選取，不自動跳
    await sleep(400);
    const other = await count();
    await clickBtn(p, (await btnLabels(p)).find((l) => /^(Next|下一題)$/.test(l)) || "Next");
    await sleep(600);
    const after = await count();
    check("流程圖：回上一題改走另一條路，總頁數變回來、下一頁換成別題", other && before && other[1] === before[1] && after && after[0] === 3 && (await modal(p)).text !== branchText,
      `${other && other.join("/")}，下一頁 ${after && after.join("/")}`);
    await answerToLast(p);
    await m.shot(p, "last");
    const last = await btnLabels(p);
    check("最後一頁有「略過並送出」", last.some((l) => /Skip and submit|略過並送出/.test(l)), last.join(" | "));
    await clickBtn(p, last.find((l) => /Skip and submit|略過並送出/.test(l)) || "Submit");
    const done = await until(async () => { const x = await modal(p); return x && /Thank|謝謝|谢谢|多謝|ありがとう|감사/.test(x.text) ? x : null; }, 15000, 100);
    check("送出後顯示打勾動畫＋謝謝", done && done.ok, done ? done.text.slice(0, 40) : "");
    await m.shot(p, "thanks");
    check("成功畫面沒有「關閉」按鈕（只有右上 ×）", done && done.buttons.join("|") === "×", done ? done.buttons.join("|") : "");
    const t1 = Date.now();
    const gone = await until(async () => (await modal(p)) === null, 5000, 100);
    check("動畫播完自動關閉", gone, `${((Date.now() - t1) / 1000).toFixed(1)} 秒`);
    const st2 = await until(async () => { const x = await m.storage(["surveyStates", "surveyLastEndedAt"]); return x.surveyStates && x.surveyStates[SURVEY_ID] && x.surveyStates[SURVEY_ID].doneAt && x.surveyLastEndedAt ? x : null; }, 10000);
    check("本機記下填完、3 天冷卻起算", !!st2);
    const rid = st2 && st2.surveyStates[SURVEY_ID].responseId, doneAt = st2 && st2.surveyStates[SURVEY_ID].doneAt;
    const sy = await m.sync("surveyDone");
    const sd = sy.surveyDone && sy.surveyDone[SURVEY_ID];
    check("填過的紀錄同步到 storage.sync（doneAt、responseId，不含答案）", sd && sd.d === doneAt && sd.r === rid && Object.keys(sd).sort().join() === "d,r", JSON.stringify(sd || null));
    // 公告入口：填過也能開（重填）：從第 1 題空白開始、沿用同一個 responseId，送出後 doneAt 更新
    await sleep(500);
    await p.evaluate((id) => { location.hash = "#bb-survey=" + id; }, SURVEY_ID);
    const again = await until(() => modal(p), 15000);
    const c2 = again && again.text.match(/(\d+)\/(\d+)\s*$/);
    check("已填過的人從公告打開：照樣打開問卷、從第 1 題開始", again && again.opts > 0 && c2 && c2[1] === "1", again ? again.text.slice(0, 60) : "");
    check("重填畫面沒有帶舊答案（沒有選取中的選項）", again && (await p.evaluate(() => document.querySelector("[data-bb-survey]").shadowRoot.querySelectorAll(".opt.on").length)) === 0);
    await m.shot(p, "refill");
    const st3 = await m.storage(["surveyStates"]);
    check("重填沿用同一個 responseId", st3.surveyStates[SURVEY_ID].responseId === rid);
    await clickIn(p, ".opt", 0); await sleep(300);
    await clickBtn(p, (await btnLabels(p)).find((l) => /^(Next|下一題)$/.test(l)) || "Next");
    await sleep(600);
    await answerToLast(p);
    await clickBtn(p, (await btnLabels(p)).find((l) => /Skip and submit|略過並送出/.test(l)) || "Submit");
    const done2 = await until(async () => { const x = await modal(p); return x && x.ok ? x : null; }, 15000, 100);
    check("重填送出後一樣是打勾動畫", !!done2);
    const st4 = await until(async () => { const x = await m.storage(["surveyStates"]); return x.surveyStates[SURVEY_ID].doneAt > doneAt ? x : null; }, 10000);
    check("重填送出後 doneAt 更新、responseId 不變", st4 && st4.surveyStates[SURVEY_ID].responseId === rid);
    const sy2 = await m.sync("surveyDone");
    check("sync 的 doneAt 也更新", sy2.surveyDone && st4 && sy2.surveyDone[SURVEY_ID].d === st4.surveyStates[SURVEY_ID].doneAt && sy2.surveyDone[SURVEY_ID].r === rid);
    console.log("    response_id（staging 資料庫查覆蓋用）:", rid);
  } finally { await m.close(); }
}

async function scenarioNone() {
  current = "none";
  console.log("\n【伺服器沒有問卷】");
  const m = await machine("N", { noSurvey: true });
  try {
    const p = await open(m, "https://www.bilibili.com/");
    await sleep(12000);
    check("首頁等 12 秒：什麼都不出現", (await modal(p)) === null);
    const st = await m.storage(["surveyStates", "surveyList"]);
    check("也沒有記下出現過", !st.surveyStates || !Object.keys(st.surveyStates).length);
    check("清單（空的）也快取起來（不一直問）", st.surveyList && Array.isArray(st.surveyList.surveys) && st.surveyList.surveys.length === 0);
  } finally { await m.close(); }
}

// 新安裝 3 天內、歡迎視窗還開著：自動邀請都不出現，也不記下邀請過（之後還會問）
async function scenarioQuiet() {
  current = "quiet";
  for (const [label, o] of [["新安裝冷靜期", { fresh: true }], ["歡迎視窗開著", { keepWelcome: true }]]) {
    console.log(`
【${label}】`);
    const m = await machine(o.fresh ? "Q1" : "Q2", o);
    try {
      const p = await open(m, "https://www.bilibili.com/");
      await sleep(12000);
      check(`${label}：首頁等 12 秒，什麼都不出現`, (await modal(p)) === null);
      const st = await m.storage(["surveyStates"]);
      check(`${label}：沒有記下出現過`, !st.surveyStates || !Object.keys(st.surveyStates).length);
    } finally { await m.close(); }
  }
}

// 出現後沒按 × 也沒填完就重新整理：今天不再出現任何問卷
async function scenarioToday() {
  current = "today";
  console.log("\n【今天出現過但沒處理】");
  const m = await machine("T");
  try {
    const p = await open(m, "https://www.bilibili.com/");
    const s = await until(() => modal(p), 40000);
    check("首頁邀請出現", !!s);
    if (!s) {
      await m.shot(p, "none");
      const st = await m.storage(["surveyStates", "surveyList", "surveyLastShown", "surveyLastEndedAt", "installedAt"]);
      console.log("    debug storage:", JSON.stringify(st, (k, v) => (k === "questions" ? "…" : v)).slice(0, 600));
      console.log("    debug page:", p.url(), "| host present:", await p.evaluate(() => !!document.querySelector("[data-bb-survey]")));
    }
    await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(12000);
    check("重新整理後等 12 秒：今天不再出現", (await modal(p)) === null);
    const st = await m.storage(["surveyStates"]);
    const x = st.surveyStates && st.surveyStates[SURVEY_ID];
    check("沒有記成關掉或填完（之後的日子還會出現）", !!x && !x.closedAt && !x.doneAt);
  } finally { await m.close(); }
}

async function scenarioAnnouncement() {
  current = "announcement";
  console.log("\n【公告連結 #bb-survey=<id>】");
  const m = await machine("A");
  try {
    const p = await open(m, `https://www.bilibili.com/#bb-survey=${SURVEY_ID}`);
    const s = await until(() => modal(p), 40000);
    check("帶 #bb-survey=<id> 的網址直接打開問卷", !!s);
    check("網址上的 hash 被拿掉", !(await p.evaluate(() => location.hash)));
    // × 關閉：馬上記下關掉、3 天冷卻起算（不等提示消失）；畫面換成「不會再出現、可以從公告找回」的提示，8 秒後自動關
    await clickIn(p, ".x");
    await sleep(300);
    const notice = await modal(p);
    check("× 關閉後顯示「不會再出現」的提示（沒有按鈕、只有右上 ×）", notice && CLOSED_RE.test(notice.msg) && notice.buttons.join("|") === "×", notice ? `${notice.msg}｜${notice.buttons.join("|")}` : "已經沒有畫面");
    await m.shot(p, "closed-notice");
    const st = await until(async () => { const x = await m.storage(["surveyStates", "surveyLastEndedAt"]); return x.surveyStates && x.surveyStates[SURVEY_ID] && x.surveyStates[SURVEY_ID].closedAt ? x : null; }, 3000);
    check("按 × 立刻記下關掉、3 天冷卻起算（提示還在時就記好）", !!(st && st.surveyLastEndedAt) && !!(await modal(p)));
    const t1 = Date.now();
    const gone = await until(async () => (await modal(p)) === null, 12000, 200);
    const secs = (Date.now() - t1 + 300) / 1000;
    check("提示約 8 秒後自動關", gone && secs >= 7 && secs <= 10, `${secs.toFixed(1)} 秒`);
    // Esc（公告入口不看「關掉過」，照樣打開）：關掉後一樣有提示，提示上再按 Esc 馬上關
    await p.evaluate((id) => { location.hash = "#bb-survey=" + id; }, SURVEY_ID);
    await until(() => modal(p), 15000);
    await p.keyboard.press("Escape");
    await sleep(300);
    const n2 = await modal(p);
    check("Esc 關閉後顯示提示", n2 && CLOSED_RE.test(n2.msg), n2 ? n2.msg : "");
    await p.keyboard.press("Escape");
    await sleep(300);
    check("提示上按 Esc 馬上關", (await modal(p)) === null);
    await m.shot(p, "closed");
  } finally { await m.close(); }
}

async function scenarioBlocked() {
  current = "blocked";
  console.log("\n【遇到地區限定】");
  // 找一集「從你現在的 IP 看不了」的番劇：用舊的 pgc playurl 問一遍時間表上的集數（不用登入），回 -10403 的就是。真的頁面照常載入、不攔截任何回應
  let ep = null;
  try {
    const H = { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" };
    const tl = await (await fetch("https://api.bilibili.com/pgc/web/timeline?types=1&before=3&after=3", { headers: H })).json();
    const eps = (tl.result || []).flatMap((d) => d.episodes || []).slice(0, 30);
    for (const e of eps) {
      const r = await (await fetch(`https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=${e.episode_id}&qn=80&fnval=16`, { headers: H })).json();
      if (r.code === -10403) { ep = e.episode_id; break; }
    }
  } catch (e) { /* 下面處理 */ }
  if (!check("找到一集從目前 IP 看不了的番劇", ep, ep ? `ep${ep}` : "時間表上沒有（IP 在大陸、或集數都能看）")) return;
  const m = await machine("B");
  try {
    const p = await m.browser.newPage();
    await m.hookFetch();
    if (argv.includes("--debug")) p.on("response", async (r) => {
      if (/ogv\/player\/playview|pgc\/player\/web/.test(r.url())) console.log("    resp:", r.status(), r.url().replace(/\?.*/, ""), "→", (await r.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " "));
    });
    await p.goto(`https://www.bilibili.com/bangumi/play/ep${ep}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    const s = await until(() => modal(p), 40000);
    check("真實頁面：出現事件觸發的問卷（說明文字是事件的那一句）", !!s && /中國大陸|中国大陆|mainland|中国|大陸|地區限定|地区限定|region/i.test(s.text), s ? s.text.slice(0, 90) : "");
    const sent = await until(async () => (await m.swCalls()).filter((u) => /\/v1\/telemetry\/blocked/.test(u)), 8000);
    check("背景送出了地區限定計數（POST /v1/telemetry/blocked，只一次）", sent && sent.length === 1, sent ? sent.join(",") : "");
    await m.shot(p, "context");
  } finally { await m.close(); }
}

const scenarios = { invite: scenarioInvite, none: scenarioNone, quiet: scenarioQuiet, today: scenarioToday, announcement: scenarioAnnouncement, blocked: scenarioBlocked };
for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY && ONLY !== name) continue;
  try { await fn(); } catch (e) { check(`${name} 執行中出錯`, false, String(e && e.message || e).slice(0, 200)); }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通過；截圖在 ${OUT}`);
process.exit(bad.length ? 1 : 0);
