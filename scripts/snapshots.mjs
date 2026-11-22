// 給擴充讀的 KV 快照（公告、抽獎、功能開關、問卷清單；內容見 tools/report-worker/src/snapshots.js）。
// 平常後台存檔、CLI 改資料時會自動寫（scripts/lib/kv-snapshot.mjs），這是手動重建與檢查用：
//   npm run snapshots -- --env staging            從 Neon 重建這個環境的全部快照，寫進 KV（用本機 wrangler 的登入）
//   npm run snapshots -- --env prod --dry         只印出會寫的內容摘要，不寫
//   --allow-empty                                 資料庫裡有表不存在時，那份也寫（寫空的）。預設不寫：可能是 .env.local 指錯資料庫，
//                                                 寫空的會把擴充看到的公告、抽獎整個清掉
// 一定要給 --env（prod 是商店版擴充讀的那份）。
import { withDb, sql } from "./lib/lotteries.mjs";
import { buildSnapshot, encodeSnapshot, snapshotKey, SNAPSHOT_NAMES } from "../tools/report-worker/src/snapshots.js";
import { useExitFlush, wranglerWriter } from "./lib/kv-snapshot.mjs";

useExitFlush(); // 這支自己寫全部快照；照所有 CLI 的規則掛上

const argv = process.argv.slice(2);
const env = argv[argv.indexOf("--env") + 1];
if (!argv.includes("--env") || !["prod", "staging"].includes(env)) {
  console.error("用法：npm run snapshots -- --env prod|staging [--dry]");
  process.exit(2);
}
const dry = argv.includes("--dry");
const allowEmpty = argv.includes("--allow-empty");

const summary = (name, d) => {
  if (name === "announcements" || name === "lotteries") return `v1 ${d.v1.length} 筆、v2 ${d.v2.length} 筆`;
  if (name === "features") return Object.keys(d).join("、") || "（沒有）";
  return d.map((s) => s.id).join("、") || "（沒有）";
};

const entries = [], skipped = [];
await withDb(env, async () => {
  for (const name of SNAPSHOT_NAMES) {
    const info = {};
    const data = await buildSnapshot(name, (q, p) => sql(q, p), info);
    const note = info.missing ? (allowEmpty ? "  ⚠ 有表不存在，照 --allow-empty 寫" : "  ⚠ 有表不存在，不寫（確定要寫空的加 --allow-empty）") : "";
    if (info.missing && !allowEmpty) skipped.push(name);
    else entries.push({ key: snapshotKey(name, env), value: encodeSnapshot(data) });
    console.log(`${snapshotKey(name, env).padEnd(26)} ${summary(name, data)}${note}`);
  }
});
if (skipped.length) {
  console.error(`⚠ 沒寫：${skipped.join("、")}。資料庫裡有表不存在：確認 .env.local 的 ${env === "staging" ? "DATABASE_URL_STAGING" : "DATABASE_URL"} 指的是對的資料庫`);
  process.exitCode = 1;
}
if (dry) {
  console.log("（--dry：沒有寫入）");
} else {
  if (entries.length) await wranglerWriter()(entries);
  console.log(`已寫進 KV（${entries.length} 個 key）`);
}
