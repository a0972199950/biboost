// 匿名統計的每日彙總（同 report worker 的 Cron，見 tools/report-worker/src/telemetry.js）：把 Analytics Engine 裡某一天（UTC）的
// 播放心跳、遇到地區限定、問卷觸發機會彙總寫回 Neon 的 telemetry_heartbeat、telemetry_blocked、survey_trigger_daily（覆蓋，重跑不會重複算）。
//   npm run telemetry:rollup -- --env staging                 前天、昨天（同 Cron）
//   npm run telemetry:rollup -- --env staging --day 2026-11-18
//   npm run telemetry:rollup -- --env prod --day 2026-11-18 --dry   只印 Analytics Engine 查到的，不寫 Neon
// 正式環境平常由 Cron 跑，這裡是補跑與測試用。需要 .env.local 的 BCS_CF_ACCOUNT_ID、BCS_CF_ANALYTICS_TOKEN（Account Analytics: Read）。
import { withDb, sql } from "./lib/lotteries.mjs";
import { aeClient, addDays, dayOf, rollupDay, rollupQueries } from "../tools/report-worker/src/telemetry.js";
import { TELEMETRY_DATASETS } from "./lib/system.mjs";
import { useExitFlush } from "./lib/kv-snapshot.mjs";

useExitFlush(); // 這支只寫統計表，不會改到快照；照所有 CLI 的規則掛上
try { process.loadEnvFile(new URL("../.env.local", import.meta.url)); } catch { /* 沒有 .env.local 就看環境變數 */ }

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const env = opt("--env");
const day = opt("--day");
if (!["prod", "staging"].includes(env) || (day && !/^\d{4}-\d{2}-\d{2}$/.test(day))) {
  console.error("用法：npm run telemetry:rollup -- --env prod|staging [--day YYYY-MM-DD] [--dry]");
  process.exit(2);
}
const ae = aeClient(String(process.env.BCS_CF_ACCOUNT_ID || "").trim(), String(process.env.BCS_CF_ANALYTICS_TOKEN || "").trim());
if (!ae) { console.error("找不到 BCS_CF_ACCOUNT_ID／BCS_CF_ANALYTICS_TOKEN（.env.local）"); process.exit(1); }
const dataset = TELEMETRY_DATASETS[env];
const today = dayOf(Date.now());
const days = day ? [day] : [addDays(today, -2), addDays(today, -1)];

for (const d of days) {
  if (argv.includes("--dry")) {
    const Q = rollupQueries(d, dataset);
    for (const [k, q] of Object.entries(Q)) console.log(d, k, JSON.stringify(await ae(q)));
    continue;
  }
  const r = await withDb(env, () => rollupDay(d, { ae, q: (q, p) => sql(q, p), dataset }));
  console.log(`${d}：心跳 ${r.heartbeat} 格、地區限定 ${r.blocked} 國、觸發機會 ${r.trigger} 列（寫進 ${env} 的 Neon）`);
}
