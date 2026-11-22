// KV 快照的寫入端（讀取端與快照內容見 tools/report-worker/src/snapshots.js）。
//
// 擴充全天都在打的公告、抽獎、功能開關、問卷清單，report worker 只讀 KV、不查 Neon；所以改了這些表，KV 就要跟著重寫，
// 漏掉一個擴充就會看到舊資料。為了不靠每個存檔動作自己記得：
//   · scripts/lib/lotteries.mjs 的 sql() 每次真的改到資料（Neon 回的 rowCount 不是 0）就呼叫 markWrite()，
//     依 SQL 裡寫到的表標記哪些快照過期（哪個環境的資料庫）；
//   · 後台（admin-api.mjs）每個動作做完呼叫 flushSnapshots(writer)，重建過期的快照、寫進 KV；寫失敗會讓那個動作回錯誤，畫面看得到；
//   · CLI（scripts/*.mjs）開頭呼叫 useExitFlush()：程式結束前 flush 一次，用本機的 wrangler 寫。要明確呼叫才會寫（單元測試裡
//     模擬的寫入不會碰到真的 KV）；test/snapshots.test.mjs 檢查每個會用到資料庫的 CLI 都有呼叫。
//   · 保底：正式環境的 report worker 每日 Cron 會整份重建（漏寫、寫失敗、有人直接改資料庫，最慢一天內修好）。
// 手動重建：npm run snapshots -- --env prod|staging（scripts/snapshots.mjs）。
//
// 寫入方式（writer = async (entries: [{ key, value }]) => void）：
//   · 雲端後台（biboost.app/admin）：site worker 的 RATE_KV 綁定（kvBindingWriter）
//   · 本機：wrangler kv bulk put（wranglerWriter），用本機 wrangler 的登入，寫 report worker 的 RATE_KV namespace
import { buildSnapshot, encodeSnapshot, snapshotKey, snapshotsTouchedBy, SNAPSHOT_NAMES } from "../../tools/report-worker/src/snapshots.js";

const dirty = new Map(); // 環境（prod｜staging）→ Set(快照名稱)

export function markWrite(db, query) {
  const names = snapshotsTouchedBy(query);
  if (!names.size) return;
  markNames(db, names);
}
let markSeq = 0; // 每標記一次 +1：後台用來判斷「這個請求有沒有產生要寫的快照」
export function markCount() { return markSeq; }
function markNames(db, names) {
  if (!dirty.has(db)) dirty.set(db, new Set());
  for (const n of names) dirty.get(db).add(n);
  markSeq++;
}
export function pendingSnapshots() { return [...dirty].map(([db, set]) => [db, [...set].sort()]); }

// 同一個程序裡 flush 一次只跑一個（排隊）：
//   · 兩個後台請求同時存檔時，先讀的那份不會比較晚寫進 KV、把新的蓋回舊的；
//   · 請求 B 的標記被 A 的 flush 拿去寫、而 A 寫失敗時，標記會放回去，輪到 B 時會再寫一次，B 回的成功或失敗是真的。
// 先把標記拿走再重建（重建時讀到的已經包含這次寫入）；失敗就把標記放回去，下次再試。
// 有表不存在（info.missing）的那份不寫：可能是指錯資料庫或環境還沒建好，寫一份空的會把擴充看到的公告、抽獎整個清掉
// （worker 自己在 KV 沒有時會查 Neon；正式環境每日 Cron 也會重建）。回傳 [[環境, 寫了哪些]]，.skipped 是 [[環境, 名稱]]
let queue = Promise.resolve();
export function flushSnapshots(writer, opts = {}) {
  const run = queue.then(() => flushNow(writer, opts));
  queue = run.catch(() => {});
  return run;
}
async function flushNow(writer, { sqlFor } = {}) {
  if (!dirty.size) return Object.assign([], { skipped: [] });
  const jobs = [...dirty].map(([db, set]) => [db, [...set]]);
  dirty.clear();
  try {
    const entries = [], written = [], skipped = [];
    const query = sqlFor || (await defaultSqlFor());
    for (const [db, names] of jobs) {
      const ok = [];
      for (const name of names) {
        const info = {};
        const data = await query(db)(name, info);
        if (info.missing) { skipped.push([db, name]); continue; }
        entries.push({ key: snapshotKey(name, db), value: encodeSnapshot(data) });
        ok.push(name);
      }
      if (ok.length) written.push([db, ok]);
    }
    if (entries.length) await writer(entries);
    return Object.assign(written, { skipped });
  } catch (e) {
    for (const [db, names] of jobs) markNames(db, names);
    throw e;
  }
}

// 手動或排錯用：重建某個環境的全部快照
export function rebuildAll(db, writer, { sqlFor } = {}) {
  markNames(db, SNAPSHOT_NAMES);
  return flushSnapshots(writer, { sqlFor });
}

// 預設：用 scripts/lib/lotteries.mjs 的 sql()，在 withDb(環境) 裡查
async function defaultSqlFor() {
  const L = await import("./lotteries.mjs");
  return (db) => (name, info) => L.withDb(db, () => buildSnapshot(name, (q, p) => L.sql(q, p), info));
}

// ── 寫入方式 ──
export function kvBindingWriter(kv) {
  return async (entries) => { for (const e of entries) await kv.put(e.key, e.value); };
}

// 本機：wrangler kv bulk put（一次寫多個 key）。namespace id 從 report worker 的 wrangler.toml 讀 RATE_KV。
// 直接用 node 執行 node_modules 裡的 wrangler（不經過 npx／shell）：Windows 上經過 shell 時逾時殺不掉真正的 wrangler，
// 卡住的話本機後台的 flush 佇列會一直卡著。非同步執行：存檔時後台不會整個卡住
const WRANGLER_TIMEOUT_MS = 120_000;
export function wranglerWriter() {
  return async (entries) => {
    const [{ default: fs }, { default: os }, { default: path }, { spawn }, { fileURLToPath }] = await Promise.all([
      import("node:fs"), import("node:os"), import("node:path"), import("node:child_process"), import("node:url"),
    ]);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const toml = fs.readFileSync(path.join(root, "tools/report-worker/wrangler.toml"), "utf8");
    const m = /binding\s*=\s*"RATE_KV"\s*\r?\n\s*id\s*=\s*"([0-9a-f]{32})"/.exec(toml);
    if (!m) throw new Error("找不到 RATE_KV 的 namespace id（tools/report-worker/wrangler.toml）");
    const bin = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!fs.existsSync(bin)) throw new Error("找不到 node_modules/wrangler（先 npm install）");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-kv-"));
    const file = path.join(dir, "bulk.json");
    try {
      fs.writeFileSync(file, JSON.stringify(entries));
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [bin, "kv", "bulk", "put", file, "--namespace-id", m[1], "--remote"],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "", timedOut = false;
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, WRANGLER_TIMEOUT_MS);
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
        child.on("exit", (code) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code, out: timedOut ? `逾時（${WRANGLER_TIMEOUT_MS / 1000} 秒）` : out }); });
      });
      // 只認看過的成功訊息；沒看過的輸出一律當失敗往上報
      if (r.code !== 0 || !/Success!/.test(r.out)) throw new Error("wrangler kv bulk put 失敗：" + String(r.out).trim().split("\n").slice(-3).join(" "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// CLI：程式結束前把過期的快照寫進 KV。beforeExit 在事件迴圈空了時觸發，可以再做非同步的事；
// 每個程序只試一次：失敗就印警告、留下 exitCode 1 後結束（不重試，否則寫不進去時會一直重試、程式永遠不結束）。
// 程式因為沒接住的錯誤結束時不會觸發 beforeExit：至少印出警告，讓人知道要手動重建。
// writer、sqlFor 預設用本機 wrangler 與 sql()（測試可以換掉）
let exitArmed = false, exitTried = false;
const warnText = (list, why) => `⚠ 資料可能已寫進資料庫，但 KV 快照沒更新（${list}）${why ? "：" + why : ""}\n  擴充會繼續看到舊資料（最慢等正式環境的每日重建），請執行 npm run snapshots -- --env <環境>`;
export function useExitFlush(writer, { sqlFor } = {}) {
  if (exitArmed || typeof process === "undefined" || typeof process.on !== "function") return;
  exitArmed = true;
  process.on("beforeExit", () => {
    if (exitTried || !dirty.size) return;
    exitTried = true;
    const list = pendingSnapshots().map(([db, n]) => `${db}：${n.join("、")}`).join("；");
    flushSnapshots(writer || wranglerWriter(), { sqlFor }).then(
      (done) => {
        if (done.length) console.error(`已更新 KV 快照（${done.map(([db, n]) => `${db}：${n.join("、")}`).join("；")}）`);
        if (done.skipped.length) console.error(`⚠ 這些快照沒寫：資料庫裡有表不存在（指錯資料庫或環境還沒建好？）：${done.skipped.map(([db, n]) => `${db}：${n}`).join("、")}`);
      },
      (e) => { console.error(warnText(list, e.message)); process.exitCode = 1; },
    );
  });
  process.on("uncaughtExceptionMonitor", () => {
    if (exitTried || !dirty.size) return;
    exitTried = true;
    console.error(warnText(pendingSnapshots().map(([db, n]) => `${db}：${n.join("、")}`).join("；"), "程式出錯中斷"));
  });
}
