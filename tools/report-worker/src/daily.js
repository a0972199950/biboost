/**
 * 每日 Cron（wrangler.toml 的 [triggers]，只有正式環境）。無人值守，所以每一種結果都要留下紀錄、讓後台看得到：
 *   0. 先在 Neon 的 cron_runs 記一筆「開始了」（detail.running = true）：中途被終止（CPU 上限、Neon 斷線）時，這筆會一直是
 *      沒跑完的狀態，後台看得到，不會變成「從來沒跑過」
 *   1. 匿名統計：前天、昨天（UTC）從 Analytics Engine 彙總回 Neon（telemetry.js）
 *   2. 重建全部 KV 快照（snapshots.js）：後台或 CLI 漏寫、寫失敗、有人直接改資料庫時，最慢一天內自己修好
 *   3. 把那筆紀錄更新成結果（ok、每一步的細節、警告）。後台「系統狀態」頁顯示（scripts/lib/system.mjs），失敗、沒跑完、超過 2 天沒成功標紅，
 *      後台每一頁上方也出現紅色橫幅
 * ok 的條件：統計有設定、兩天都彙總成功、快照每一份都成功（表還不存在算成功：那就是現況）。其他一律 ok = false 往上報。
 * 警告（不算失敗，但要人看）：某天心跳 0 格；昨天的心跳或觸發機會比前 7 天平均少一半以上（可能是 Analytics Engine 寫入額度
 * 用完、端點壞了）；某份快照原本有資料、重建後變空的。
 */
import { refreshAllSnapshots } from "./snapshots.js";
import { addDays, dayOf, scheduledRollup } from "./telemetry.js";

export const CRON_RUNS_TABLE = `create table if not exists cron_runs (
    id bigserial primary key,
    name text not null,
    ran_at timestamptz not null default now(),
    ok boolean not null,
    detail jsonb not null)`;
const DROP_MIN_AVG = 100; // 前 7 天平均太小時不比（數字小，掉一半也可能只是正常波動）

const errText = (e) => String((e && e.message) || e).slice(0, 300);

// 昨天比前 7 天平均少一半以上
async function dropWarnings(q, now) {
  const out = [];
  const y = addDays(dayOf(now), -1), from = addDays(y, -7);
  const ms = (d) => Date.parse(d + "T00:00:00Z");
  const checks = [
    ["播放心跳", "select coalesce(sum(n), 0)::int as n from telemetry_heartbeat where bucket >= $1 and bucket < $2", (a, b) => [ms(a), ms(b)]],
    ["問卷觸發機會", "select coalesce(sum(n), 0)::int as n from survey_trigger_daily where day >= $1 and day < $2", (a, b) => [a, b]],
  ];
  for (const [label, sql, args] of checks) {
    const [{ n: yn }] = await q(sql, args(y, addDays(y, 1)));
    const [{ n: wn }] = await q(sql, args(from, y));
    const avg = wn / 7;
    if (avg >= DROP_MIN_AVG && yn < avg / 2) out.push(`${y} 的${label}只有 ${yn}，前 7 天平均 ${Math.round(avg)}（少一半以上：Analytics Engine 寫入額度、端點或擴充可能有問題）`);
  }
  return out;
}

export async function runDaily(env, q, now = Date.now(), fetchImpl = fetch) {
  const detail = { rollup: null, snapshots: null, warnings: [] };
  let runId = null;
  try {
    await q(CRON_RUNS_TABLE);
    const rows = await q("insert into cron_runs (name, ok, detail) values ('daily', false, $1::jsonb) returning id", [JSON.stringify({ running: true })]);
    runId = rows[0] && rows[0].id;
  } catch (e) {
    detail.recordError = errText(e); // 連開始都記不了：下面照做，最後再試一次
  }

  try { detail.rollup = await scheduledRollup(env, q, now, fetchImpl); }
  catch (e) { detail.rollup = { configured: true, error: errText(e), days: [] }; }
  try { detail.snapshots = await refreshAllSnapshots(env, q, now); }
  catch (e) { detail.snapshots = { error: errText(e) }; }

  const r = detail.rollup;
  if (r && r.configured === false) detail.warnings.push(`匿名統計的每日彙總沒有設定：${(r.missing || []).join("、")}`);
  for (const d of (r && r.days) || []) if (!d.error && d.heartbeat === 0) detail.warnings.push(`${d.day} 沒有任何播放心跳`);
  for (const [name, v] of Object.entries(detail.snapshots || {})) {
    const m = /^ok_emptied:(\d+)$/.exec(String(v));
    if (m) detail.warnings.push(`快照 ${name} 原本有 ${m[1]} 筆，重建後是空的（確認是不是真的都結束或刪掉了）`);
  }
  const rollupOk = !!r && r.configured === true && !r.error && r.days.length > 0 && r.days.every((d) => !d.error);
  if (rollupOk) {
    try { detail.warnings.push(...(await dropWarnings(q, now))); } catch (e) { detail.warnings.push(`比對前 7 天失敗：${errText(e)}`); }
  }
  const snapsOk = !!detail.snapshots && !detail.snapshots.error
    && Object.values(detail.snapshots).every((v) => v === "ok" || v === "skipped_missing_table" || /^ok_emptied:\d+$/.test(String(v)));
  const ok = rollupOk && snapsOk;

  try {
    if (runId != null) await q("update cron_runs set ok = $1, detail = $2::jsonb where id = $3", [ok, JSON.stringify(detail), runId]);
    else { await q(CRON_RUNS_TABLE); await q("insert into cron_runs (name, ok, detail) values ('daily', $1, $2::jsonb)", [ok, JSON.stringify(detail)]); }
  } catch (e) {
    detail.recordError = errText(e); // 連 Neon 都寫不進去：至少 wrangler tail 看得到；後台會看到「超過 2 天沒成功」
  }
  console.log("daily", ok ? "ok" : "FAILED", JSON.stringify(detail));
  return { ok, ...detail };
}

// 部署正式 report worker 時記一筆（scripts/mark-deployed.mjs）：部署後超過一天還沒有任何每日工作的紀錄，後台就標紅
// （否則 Cron 根本沒觸發時，畫面會永遠停在「還沒跑過」）
export async function markDeployed(q, what = "report-worker") {
  await q(CRON_RUNS_TABLE);
  await q("insert into cron_runs (name, ok, detail) values ('deployed', true, $1::jsonb)", [JSON.stringify({ what })]);
}
