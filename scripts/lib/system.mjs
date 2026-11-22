// 後台「系統狀態」頁的資料：每日工作（report worker 的 tools/report-worker/src/daily.js）的執行紀錄與健康判斷、
// 匿名統計（播放心跳、遇到地區限定）。admin-api.mjs 的 dailyRunStatus、telemetryStats 動作用這一份；環境（正式／測試）用 lotteries.mjs 的 withDb 切換。
//
// 只讀：這裡不建任何表（正式環境可能還沒部署過、還沒有這些表）。表不存在就回空的／never。
// 今天、昨天（UTC）的統計還沒彙總回 Neon：有 .env.local 的 BCS_CF_ACCOUNT_ID、BCS_CF_ANALYTICS_TOKEN（本機後台）時直接查 Analytics Engine 補上，
// 雲端後台沒有這兩個，只有 Neon 的歷史（回傳的 recent.configured = false，畫面註明）。
import { sql, currentDb } from "./lotteries.mjs";
import { aeClient, addDays, dayOf, ROW_LIMIT } from "../../tools/report-worker/src/telemetry.js";

export const TELEMETRY_DATASETS = { prod: "bb_telemetry", staging: "bb_telemetry_staging" };
export const HEARTBEAT_SAMPLE = 10; // 只有 10% 的安裝送心跳：同時觀看人數 ≈ 一格的心跳數 × 10
const BUCKET_MS = 300_000; // 心跳 5 分鐘一格
const DAY_MS = 86_400_000;
const DS_RE = /^[a-z0-9_]{1,64}$/;
const COUNTRY_RE = /^[A-Z0-9]{2}$/;

// Analytics Engine 的查詢函式（沒設定回 null）。要先呼叫過 sql()（它會載入 .env.local）
export function aeFromEnv() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  return aeClient(String(env.BCS_CF_ACCOUNT_ID || "").trim(), String(env.BCS_CF_ANALYTICS_TOKEN || "").trim());
}

// 表存不存在（to_regclass，不建表）。存在的記起來，不存在的每次都問（部署後會出現）
const seen = {};
export async function tableExists(name, q = sql) {
  const key = q === sql ? `${currentDb()}:${name}` : null; // 測試傳進來的假資料庫不記
  if (key && seen[key]) return true;
  const [{ t }] = await q(`select to_regclass('public.${name}')::text as t`);
  if (t && key) seen[key] = true;
  return !!t;
}

export const twTime = (t) => (t ? new Date(t).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

// ── 每日工作 ──
export const STALE_MS = 2 * DAY_MS; // 超過 2 天沒成功
export const RUNNING_MAX_MS = 60 * 60_000; // 開始超過 1 小時還沒寫完 = 中途被終止
export const FIRST_RUN_MS = 26 * 3_600_000; // 部署後最晚隔天 08:20 會跑第一次
const RUN_HINT = "超過 3 個月沒補，Analytics Engine 的原始資料就沒了。補跑：npm run telemetry:rollup -- --env prod --day YYYY-MM-DD；快照：npm run snapshots -- --env prod";

// 一次執行的 detail 裡寫了哪些失敗（統計彙總、每一天、快照、記錄）
export function dailyProblems(d) {
  const out = [];
  const r = d && d.rollup;
  if (r && r.error) out.push(`統計彙總失敗：${r.error}`);
  for (const x of (r && r.days) || []) if (x.error) out.push(`${x.day} 彙總失敗：${x.error}`);
  const snaps = (d && d.snapshots) || {};
  if (snaps.error) out.push(`快照重建失敗：${snaps.error}`);
  else for (const [k, v] of Object.entries(snaps)) if (v !== "ok" && v !== "skipped_missing_table" && !/^ok_emptied:/.test(String(v))) out.push(`快照 ${k}：${v}`);
  if (d && d.recordError) out.push(`記錄失敗：${d.recordError}`);
  return out;
}

// 一筆紀錄的狀態：ok／failed／running（開始了還沒寫完）／cut（開始超過 1 小時還沒寫完＝中途被終止）
export function runState(run, now = Date.now()) {
  if (!run) return null;
  if (run.detail && run.detail.running) return now - run.ranAt > RUNNING_MAX_MS ? "cut" : "running";
  return run.ok ? "ok" : "failed";
}

// 健康判斷：{ level: "error"｜"warning"｜"ok"｜"info", title, lines: [] }。
//   scheduled：這個環境有排程（正式）。測試環境不排程：不看「從來沒跑過」「超過 2 天沒成功」，只看最近一次的結果
// error（紅）：最近一次失敗、中途被終止、超過 2 天沒成功、部署後超過 26 小時一次都沒跑過；warning（黃）：完成但有警告
export function dailyHealth(s, now = Date.now(), { scheduled = true } = {}) {
  if (!s || s.never) {
    if (scheduled && s && s.deployedAt && now - s.deployedAt > FIRST_RUN_MS) return {
      level: "error", title: `每日工作從來沒跑過：正式 report worker 在 ${twTime(s.deployedAt)} 部署，應該每天 UTC 00:20（台灣 08:20）跑一次`,
      lines: ["看 Cloudflare 上 bcs-report 的 Triggers 有沒有 Cron、npx wrangler tail bcs-report 有沒有錯誤。"],
    };
    return {
      level: "info", lines: [],
      title: scheduled ? "每日工作（匿名統計彙總、快照重建）還沒跑過：正式環境的 report worker 部署後，每天 UTC 00:20（台灣 08:20）跑一次。" : "這個環境沒有每日工作的紀錄。",
    };
  }
  const state = runState(s.last, now);
  const okText = s.lastOk ? `最後成功：${twTime(s.lastOk.ranAt)}（台灣時間）` : "從來沒有成功過";
  const problems = state === "cut" ? [`${twTime(s.last.ranAt)} 開始的那次沒跑完（中途被終止：CPU 上限、Neon 斷線？看 npx wrangler tail bcs-report）`]
    : state === "failed" ? dailyProblems(s.last.detail) : [];
  const warnings = (state !== "running" && s.last && s.last.detail && s.last.detail.warnings) || [];
  // 失敗的原因有時只寫在警告裡（例如統計沒有設定 secret：daily.js 記成警告、ok = false）
  if (state === "failed" && !problems.length && !warnings.length) problems.push("最近一次執行失敗（紀錄裡沒有寫原因）");
  const stale = scheduled && (!s.lastOk || now - s.lastOk.ranAt > STALE_MS);
  if (stale && !problems.length) problems.push("超過 2 天沒有成功執行");
  const failed = state === "failed" || state === "cut" || stale;
  if (failed) return { level: "error", title: `每日工作有問題，${okText}`, lines: problems.concat(warnings, scheduled ? [RUN_HINT] : []) };
  if (state === "running") return { level: "ok", title: `每日工作執行中（${twTime(s.last.ranAt)} 開始），${okText}`, lines: [] };
  if (warnings.length) return { level: "warning", title: `每日工作完成，有警告（${okText}）`, lines: warnings };
  return { level: "ok", title: `每日工作正常，${okText}`, lines: [] };
}

// 每日工作最近的執行紀錄：{ never, last, lastOk, deployedAt, runs: [最近 limit 筆], health }。
// 每一筆是 { id, ranAt, ok, state, detail }。還沒有 cron_runs 表（正式環境還沒部署過 Cron、或測試環境沒手動跑過）回 never
export async function dailyRunStatus({ q = sql, now = Date.now(), limit = 10, scheduled = currentDb() === "prod" } = {}) {
  if (!(await tableExists("cron_runs", q))) {
    const s = { never: true, last: null, lastOk: null, deployedAt: null, runs: [] };
    return { ...s, health: dailyHealth(s, now, { scheduled }) };
  }
  const run = (r) => {
    const x = { id: Number(r.id), ranAt: new Date(r.ran_at).getTime(), ok: !!r.ok, detail: r.detail || {} };
    return { ...x, state: runState(x, now) };
  };
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  const [runs, lastOk, deployed] = await Promise.all([
    q(`select id, ran_at, ok, detail from cron_runs where name = 'daily' order by ran_at desc, id desc limit ${lim}`),
    q("select id, ran_at, ok, detail from cron_runs where name = 'daily' and ok order by ran_at desc, id desc limit 1"),
    q("select ran_at from cron_runs where name = 'deployed' order by ran_at desc limit 1"),
  ]);
  // deployedAt：最近一次部署正式 report worker 的時間（scripts/mark-deployed.mjs）
  const s = {
    never: !runs.length, last: runs[0] ? run(runs[0]) : null, lastOk: lastOk[0] ? run(lastOk[0]) : null,
    deployedAt: deployed[0] ? new Date(deployed[0].ran_at).getTime() : null, runs: runs.map(run),
  };
  return { ...s, health: dailyHealth(s, now, { scheduled }) };
}

// ── 匿名統計 ──
const startMs = (day) => Date.parse(day + "T00:00:00Z");
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const num = (x) => Math.max(0, Math.round(Number(x) || 0));

// 這一天有幾格（算平均用）：過去的日子 288 格；今天只算到現在
export function slotsOf(day, now = Date.now()) {
  const s = startMs(day);
  if (now >= s + DAY_MS) return DAY_MS / BUCKET_MS;
  if (now < s) return 0;
  return Math.floor((now - s) / BUCKET_MS) + 1;
}

// 每一格（所有國家加總）的心跳數 [{ bucket, n }] → 每天 { day, buckets: 有資料的格數, total, peak, peakAt }
export function summarizeBuckets(rows) {
  const out = new Map();
  for (const r of rows) {
    const b = Number(r.bucket), n = num(r.n);
    if (!Number.isFinite(b)) continue;
    const day = dayOf(b);
    const d = out.get(day) || { day, buckets: 0, total: 0, peak: 0, peakAt: null };
    d.buckets++; d.total += n;
    if (n > d.peak) { d.peak = n; d.peakAt = b; }
    out.set(day, d);
  }
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Analytics Engine：從 fromDay 00:00（UTC）到現在的心跳（每一格 × 國家）與地區限定（每天 × 國家）。
// 心跳四捨五入到最近的 5 分鐘，跟每日彙總（telemetry.js 的 rollupQueries）一樣：fromDay 的第一格從前一天 23:57:30 起算
export async function recentFromAe(ae, dataset, fromDay) {
  if (!DS_RE.test(dataset) || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay)) throw new Error("bad dataset or day");
  const from = startMs(fromDay), half = BUCKET_MS / 2;
  const [hb, bl] = await Promise.all([
    ae(`SELECT intDiv(toUInt32(timestamp) + ${half / 1000}, ${BUCKET_MS / 1000}) * ${BUCKET_MS / 1000} AS b, blob2 AS country, SUM(_sample_interval) AS n
      FROM ${dataset} WHERE blob1 = 'heartbeat' AND timestamp >= toDateTime('${fmt(from - half)}') GROUP BY b, country LIMIT ${ROW_LIMIT}`),
    ae(`SELECT intDiv(toUInt32(timestamp), 86400) * 86400 AS d, blob2 AS country, SUM(_sample_interval) AS n
      FROM ${dataset} WHERE blob1 = 'blocked' AND timestamp >= toDateTime('${fmt(from)}') GROUP BY d, country LIMIT ${ROW_LIMIT}`),
  ]);
  const heartbeat = hb.map((r) => ({ bucket: Number(r.b) * 1000, country: String(r.country), n: num(r.n) }))
    .filter((r) => r.bucket >= from && COUNTRY_RE.test(r.country) && r.n > 0);
  const blocked = bl.map((r) => ({ day: dayOf(Number(r.d) * 1000), country: String(r.country), n: num(r.n) }))
    .filter((r) => r.day >= fromDay && COUNTRY_RE.test(r.country) && r.n > 0);
  return { heartbeat, blocked };
}

// 最近 days 天（UTC，含今天）：
//   heartbeat：每天 { day, buckets, slots, total, peak, peakAt, avg, source: "neon"｜"ae" }，沒有資料的日子不列（畫面補空的）
//   countries：每天 × 國家 { day, country, total, peak }（peak 是那個國家當天最高的一格）
//   blocked：每天 × 國家 { day, country, n }
//   recent：{ configured, days: [Analytics Engine 補上的日子], error? }
// 數字都是原始心跳數（×HEARTBEAT_SAMPLE 才是人數，畫面算）。同一天 Neon 與 Analytics Engine 都有時用 Analytics Engine 的（比較新）
export async function telemetryStats({ days = 14, now = Date.now(), q = sql, ae, dataset = TELEMETRY_DATASETS[currentDb()] } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 14));
  const today = dayOf(now), fromDay = addDays(today, -(n - 1));
  const from = startMs(fromDay);
  const [hasHb, hasBl] = [await tableExists("telemetry_heartbeat", q), await tableExists("telemetry_blocked", q)];
  const [buckets, dayCountry, blocked] = await Promise.all([
    hasHb ? q("select bucket, sum(n)::int as n from telemetry_heartbeat where bucket >= $1 group by bucket order by bucket", [from]) : [],
    hasHb ? q(`select (bucket / ${DAY_MS})::bigint as d, country, sum(n)::int as total, max(n)::int as peak
        from telemetry_heartbeat where bucket >= $1 group by 1, 2`, [from]) : [],
    hasBl ? q("select day, country, sum(n)::int as n from telemetry_blocked where day >= $1 group by day, country order by day, country", [fromDay]) : [],
  ]);
  let hbDays = summarizeBuckets(buckets).map((d) => ({ ...d, source: "neon" }));
  let countries = dayCountry.map((r) => ({ day: dayOf(Number(r.d) * DAY_MS), country: String(r.country), total: num(r.total), peak: num(r.peak) }));
  let bl = blocked.map((r) => ({ day: String(r.day), country: String(r.country), n: num(r.n) }));

  const client = ae === undefined ? aeFromEnv() : ae;
  const recent = { configured: !!client, days: [] };
  if (client) {
    try {
      const aeFrom = addDays(today, -1) < fromDay ? fromDay : addDays(today, -1); // 今天、昨天
      const r = await recentFromAe(client, dataset, aeFrom);
      const fresh = new Set();
      for (let d = aeFrom; d <= today; d = addDays(d, 1)) fresh.add(d);
      recent.days = [...fresh];
      // 每一格 × 國家 → 每一格的加總、每天 × 國家
      const perBucket = new Map(), perDc = new Map();
      for (const x of r.heartbeat) {
        perBucket.set(x.bucket, (perBucket.get(x.bucket) || 0) + x.n);
        const k = `${dayOf(x.bucket)}|${x.country}`;
        const c = perDc.get(k) || { day: dayOf(x.bucket), country: x.country, total: 0, peak: 0 };
        c.total += x.n; c.peak = Math.max(c.peak, x.n);
        perDc.set(k, c);
      }
      hbDays = hbDays.filter((d) => !fresh.has(d.day)).concat(summarizeBuckets([...perBucket].map(([bucket, v]) => ({ bucket, n: v }))).map((d) => ({ ...d, source: "ae" })));
      countries = countries.filter((c) => !fresh.has(c.day)).concat([...perDc.values()]);
      bl = bl.filter((x) => !fresh.has(x.day)).concat(r.blocked);
    } catch (e) {
      recent.error = String((e && e.message) || e).slice(0, 300);
    }
  }
  const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  hbDays = hbDays.filter((d) => d.day >= fromDay && d.day <= today).sort(byDay).map((d) => {
    const slots = slotsOf(d.day, now);
    return { ...d, slots, avg: slots ? d.total / slots : 0 };
  });
  return {
    from: fromDay, to: today, sample: HEARTBEAT_SAMPLE, tables: { heartbeat: hasHb, blocked: hasBl },
    heartbeat: hbDays,
    countries: countries.filter((c) => c.day >= fromDay && c.day <= today && c.total > 0).sort((a, b) => byDay(a, b) || (a.country < b.country ? -1 : 1)),
    blocked: bl.filter((x) => x.day >= fromDay && x.day <= today).sort((a, b) => byDay(a, b) || (a.country < b.country ? -1 : 1)),
    recent,
  };
}
