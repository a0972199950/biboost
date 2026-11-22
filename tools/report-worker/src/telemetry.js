/**
 * 匿名統計：抽樣播放心跳、遇到地區限定、問卷觸發機會。每個請求都碰 Neon 會讓資料庫 24 小時開著，
 * 所以請求只寫 Workers Analytics Engine（binding TELEMETRY），每天由 Cron 把前一天（UTC）的彙總寫回 Neon 的三張表，
 * Analytics Engine 只留 3 個月、Neon 長期保存。這個檔案是純 ESM：worker 的 Cron 與本機的 scripts/telemetry-rollup.mjs 共用。
 *
 * 資料點：blobs = [種類 heartbeat|blocked|trigger, 國家, 觸發方式, 結果]，doubles = [1]，indexes = [國家]；時間用寫入時間。
 * 彙總寫回用覆蓋（n = excluded.n），同一天重跑不會重複計算；Analytics Engine 流量大會抽樣，計數一律 SUM(_sample_interval)。
 */
export const KINDS = ["heartbeat", "blocked", "trigger"];
const BUCKET_S = 300;
// 一個查詢最多拿幾列。心跳一天最多 288 格 × 國家數（目前遠低於上限），觸發機會、地區限定更少；到上限就當成可能被截斷
export const ROW_LIMIT = 50_000; // 心跳的 5 分鐘一格（四捨五入到最近的整 5 分鐘，跟原本直接寫 Neon 時一樣）

// 三張表（後台的 scripts/lib/surveys.mjs 也用這份建表）
export const TELEMETRY_TABLES = [
  `create table if not exists survey_trigger_daily (
      day text not null,
      country text not null,
      trigger text not null,
      result text not null,
      n integer not null,
      primary key (day, country, trigger, result))`,
  "create table if not exists telemetry_heartbeat (bucket bigint not null, country text not null, n integer not null, primary key (bucket, country))",
  "create table if not exists telemetry_blocked (day text not null, country text not null, n integer not null, primary key (day, country))",
];

export function writePoint(env, kind, country, trigger = "", result = "") {
  if (!env.TELEMETRY || typeof env.TELEMETRY.writeDataPoint !== "function") return false;
  try {
    env.TELEMETRY.writeDataPoint({ blobs: [kind, country, trigger, result], doubles: [1], indexes: [country] });
    return true;
  } catch (e) {
    return false; // 統計失敗不影響擴充
  }
}

// ── Analytics Engine 的 SQL API（帳號 id ＋ Account Analytics: Read 權限的 token）──
export function aeClient(accountId, token, fetchImpl = fetch) {
  if (!accountId || !token) return null;
  return async (query) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: query + " FORMAT JSON",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`analytics_engine_${res.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    const data = j.data || [];
    // 每個查詢都明確加 LIMIT ROW_LIMIT：回來的列數到了上限，就可能有被截掉的，丟錯，不要用少算的數字覆蓋 Neon。
    // （回應裡的 rows_before_limit_at_least 不能用：沒有 LIMIT 時也會出現，而且跟實際列數對不上，2026-11-18 在 staging 實測）
    if (data.length >= ROW_LIMIT) throw new Error(`analytics_engine_truncated ${data.length}`);
    return data;
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DS_RE = /^[a-z0-9_]{1,64}$/;
const COUNTRY_RE = /^[A-Z0-9]{2}$/;
const TOKEN_RE = /^[a-z_]{1,24}$/;
const fmt = (sec) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
const startOf = (day) => Date.parse(day + "T00:00:00Z") / 1000;
export function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(day, n) { return dayOf(Date.parse(day + "T00:00:00Z") + n * 86_400_000); }

// 這一天（UTC）三種資料的查詢。心跳四捨五入到最近的 5 分鐘：這一天的格子是 [00:00, 隔天 00:00)，
// 所以時間範圍往前挪半格（前一天 23:57:30 起算），每一格只會落在其中一天的彙總裡、不會被兩天互相覆蓋
export function rollupQueries(day, dataset) {
  if (!DAY_RE.test(day) || !DS_RE.test(dataset)) throw new Error("bad day or dataset");
  const d = startOf(day), half = BUCKET_S / 2;
  const range = (a, b) => `timestamp >= toDateTime('${fmt(a)}') AND timestamp < toDateTime('${fmt(b)}')`;
  return {
    heartbeat: `SELECT intDiv(toUInt32(timestamp) + ${half}, ${BUCKET_S}) * ${BUCKET_S} AS b, blob2 AS country, SUM(_sample_interval) AS n
      FROM ${dataset} WHERE blob1 = 'heartbeat' AND ${range(d - half, d + 86400 - half)} GROUP BY b, country LIMIT ${ROW_LIMIT}`,
    blocked: `SELECT blob2 AS country, SUM(_sample_interval) AS n
      FROM ${dataset} WHERE blob1 = 'blocked' AND ${range(d, d + 86400)} GROUP BY country LIMIT ${ROW_LIMIT}`,
    trigger: `SELECT blob2 AS country, blob3 AS trigger, blob4 AS result, SUM(_sample_interval) AS n
      FROM ${dataset} WHERE blob1 = 'trigger' AND ${range(d, d + 86400)} GROUP BY country, trigger, result LIMIT ${ROW_LIMIT}`,
  };
}

const n = (x) => Math.max(0, Math.round(Number(x) || 0));

// 把某一天彙總寫回 Neon（q = async (sql, params) => rows）。回傳各表寫了幾列。
// Analytics Engine 查詢失敗就整個丟錯（不寫任何東西），不會用空結果蓋掉資料
export async function rollupDay(day, { ae, q, dataset }) {
  const Q = rollupQueries(day, dataset);
  const [hb, bl, tr] = await Promise.all([ae(Q.heartbeat), ae(Q.blocked), ae(Q.trigger)]);
  for (const sql of TELEMETRY_TABLES) await q(sql);
  const lo = startOf(day) * 1000, hi = lo + 86_400_000;
  const hbRows = hb.map((r) => [Number(r.b) * 1000, String(r.country), n(r.n)]).filter(([b, c, k]) => b >= lo && b < hi && COUNTRY_RE.test(c) && k > 0);
  const blRows = bl.map((r) => [String(r.country), n(r.n)]).filter(([c, k]) => COUNTRY_RE.test(c) && k > 0);
  const trRows = tr.map((r) => [String(r.country), String(r.trigger), String(r.result), n(r.n)])
    .filter(([c, t, res, k]) => COUNTRY_RE.test(c) && TOKEN_RE.test(t) && TOKEN_RE.test(res) && k > 0);
  // 一次寫多列：整批當成一個 JSON 參數（Neon 的 HTTP SQL 參數不保證支援陣列）
  const js = (rows, keys) => JSON.stringify(rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]]))));
  if (hbRows.length) await q(`insert into telemetry_heartbeat (bucket, country, n)
      select bucket, country, n from jsonb_to_recordset($1::jsonb) as x(bucket bigint, country text, n int)
      on conflict (bucket, country) do update set n = excluded.n`, [js(hbRows, ["bucket", "country", "n"])]);
  if (blRows.length) await q(`insert into telemetry_blocked (day, country, n)
      select $1, country, n from jsonb_to_recordset($2::jsonb) as x(country text, n int)
      on conflict (day, country) do update set n = excluded.n`, [day, js(blRows, ["country", "n"])]);
  if (trRows.length) await q(`insert into survey_trigger_daily (day, country, trigger, result, n)
      select $1, country, trigger, result, n from jsonb_to_recordset($2::jsonb) as x(country text, trigger text, result text, n int)
      on conflict (day, country, trigger, result) do update set n = excluded.n`, [day, js(trRows, ["country", "trigger", "result", "n"])]);
  return { day, heartbeat: hbRows.length, blocked: blRows.length, trigger: trRows.length };
}

// Cron：彙總前天、昨天（UTC）。前天重算一次是保險：哪天 Cron 失敗或資料晚到，隔天會補上（覆蓋，不會重複算）
// 回傳 { configured, days: [{ day, heartbeat, blocked, trigger } | { day, error }] }；沒設定也要回報（daily.js 會記進 cron_runs），不默默跳過
export async function scheduledRollup(env, q, now = Date.now(), fetchImpl = fetch) {
  const ae = aeClient(env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN, fetchImpl);
  const missing = [!env.CF_ACCOUNT_ID && "CF_ACCOUNT_ID", !env.CF_ANALYTICS_TOKEN && "CF_ANALYTICS_TOKEN", !env.TELEMETRY_DATASET && "TELEMETRY_DATASET", !env.DATABASE_URL && "DATABASE_URL"].filter(Boolean);
  if (!ae || missing.length) return { configured: false, missing, days: [] };
  const today = dayOf(now), days = [];
  for (const day of [addDays(today, -2), addDays(today, -1)]) {
    try { days.push(await rollupDay(day, { ae, q, dataset: env.TELEMETRY_DATASET })); }
    catch (e) { days.push({ day, error: String((e && e.message) || e).slice(0, 300) }); }
  }
  return { configured: true, days };
}

// admin：還沒寫回 Neon 的這兩天（今天、昨天）的觸發機會，直接查 Analytics Engine。回傳跟 Neon 的 survey_trigger_daily 彙總同格式
export async function recentTriggers(ae, dataset, now = Date.now()) {
  if (!DS_RE.test(dataset)) throw new Error("bad dataset");
  const from = startOf(addDays(dayOf(now), -1));
  const rows = await ae(`SELECT intDiv(toUInt32(timestamp), 86400) * 86400 AS d, blob3 AS trigger, blob4 AS result, SUM(_sample_interval) AS n
    FROM ${dataset} WHERE blob1 = 'trigger' AND timestamp >= toDateTime('${fmt(from)}') GROUP BY d, trigger, result ORDER BY d, trigger, result LIMIT ${ROW_LIMIT}`);
  return rows.map((r) => ({ day: dayOf(Number(r.d) * 1000), trigger: String(r.trigger), result: String(r.result), n: n(r.n) }));
}
