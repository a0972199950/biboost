// 部署正式 report worker 後記一筆「部署了」（Neon 的 cron_runs，見 tools/report-worker/src/daily.js 的 markDeployed）。
// npm run worker:deploy 會在 wrangler deploy 成功後自動跑。後台問卷頁（正式）用它判斷：部署後超過一天還沒有每日工作的紀錄就標紅
// （Cron 根本沒觸發時，否則會永遠顯示「還沒跑過」）。只記正式環境（測試環境不排程）。
import { withDb, sql } from "./lib/lotteries.mjs";
import { markDeployed } from "../tools/report-worker/src/daily.js";
import { useExitFlush } from "./lib/kv-snapshot.mjs";

useExitFlush(); // 只寫 cron_runs，不會改到快照；照所有 CLI 的規則掛上

try {
  await withDb("prod", () => markDeployed((q, p) => sql(q, p)));
  console.log("已記下部署時間（cron_runs）");
} catch (e) {
  // 部署本身已經成功；記不下來只影響後台的提醒，印出來讓人知道
  console.error(`⚠ 部署成功，但沒記下部署時間：${e.message}（後台的「每日工作」提醒會不準，可以再跑一次 node scripts/mark-deployed.mjs）`);
  process.exitCode = 1;
}
