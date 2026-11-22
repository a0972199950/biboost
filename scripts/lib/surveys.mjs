// 問卷（Neon 的 surveys 等資料表）的共用邏輯：建表、列出、草稿、發布、停止、複製、複製到另一個環境。
// scripts/surveys.mjs（CLI）與後台（經過 admin-api.mjs）都用這一份；環境（正式／測試）用 lotteries.mjs 的 withDb 切換。
// 問卷定義的格式與驗證在擴充的 src/survey-core.js（擴充、report worker、這裡共用同一份）。
//
// 狀態：draft（草稿，可以改）→ published（已發布，內容鎖住，只能停止）。
//   結束（ended_at）的原因：manual（手動停止）、full（送出完成的份數到上限，report worker 送出時設）；到期不寫欄位，看 ends_at。
//   結束只關掉入口（GET /v2/surveys 不再列出），已經在填的人照樣可以送出（作答標 after_end）。
// 錯誤一律丟 SurveyAdminError（訊息給人看的中文）。
import "../../src/survey-core.js";
import { sql, withDb, currentDb, DB_ENVS } from "./lotteries.mjs";
import { TELEMETRY_TABLES, recentTriggers } from "../../tools/report-worker/src/telemetry.js";
import { TELEMETRY_DATASETS, aeFromEnv } from "./system.mjs";

const Core = globalThis.BBSurveyCore;
export class SurveyAdminError extends Error {
  constructor(message, details) { super(message); this.details = details || null; }
}

const ready = {}; // 每個資料庫（正式／測試）各建一次表
export function ensureSurveyTables() {
  const db = currentDb();
  ready[db] ||= (async () => {
    await sql(`create table if not exists surveys (
      id text primary key,
      name text not null default '',
      def jsonb not null,
      status text not null default 'draft',
      starts_at timestamptz,
      ends_at timestamptz,
      max_responses integer,
      published_at timestamptz,
      ended_at timestamptz,
      ended_reason text,
      completed_count integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now())`);
    // 作答（2026-11-09 起由問卷 API 建立；這裡補上多問卷模組要的欄位）。時間是毫秒，布林存 0／1
    await sql(`create table if not exists survey_responses (
      response_id text primary key,
      survey_id text not null,
      version integer not null,
      answers jsonb not null,
      email text,
      country text not null,
      entry text not null,
      browser text,
      ext_version text,
      lang text,
      install_days text,
      custom_nodes integer,
      completed integer not null default 0,
      created_at bigint not null,
      updated_at bigint not null)`);
    await sql("alter table survey_responses add column if not exists after_end integer not null default 0");
    await sql("alter table survey_responses add column if not exists started_at bigint");
    await sql("alter table survey_responses add column if not exists completed_at bigint");
    await sql("create index if not exists survey_responses_survey on survey_responses (survey_id, completed)");
    // IP 的 HMAC 雜湊（report worker 有設 IP_HASH_SECRET 才寫；還原不回 IP），只用來標記「同 IP、同一小時、答案完全一樣」（不另外清除，只在分析時用）
    await sql("alter table survey_responses add column if not exists ip_hash text");
    // 每一筆出現、換頁（停留時間）、關掉、完成；不存 IP、不存裝置識別碼（response_id 是每份作答的亂數）
    await sql(`create table if not exists survey_events (
      id bigserial primary key,
      response_id text not null,
      survey_id text not null,
      kind text not null,
      page integer,
      question text,
      ms integer,
      entry text,
      country text not null,
      lang text,
      browser text,
      ext_version text,
      at bigint not null)`);
    await sql("create index if not exists survey_events_survey on survey_events (survey_id, kind)");
    // 觸發機會（每天 × 國家 × 觸發方式 × 結果）、播放心跳、遇到地區限定：worker 寫 Analytics Engine，每天 Cron 彙總寫回這三張表
    // （tools/report-worker/src/telemetry.js，建表的 SQL 也在那邊，兩邊共用）
    for (const ddl of TELEMETRY_TABLES) await sql(ddl);
  })().catch((e) => { ready[db] = null; throw e; });
  return ready[db];
}

// 只讀的動作（列表、內容、結果）不建表：看一眼正式環境的頁面不該改到正式資料庫的 schema。還沒建表＝沒有問卷
const exists = {};
async function hasTables() {
  const db = currentDb();
  if (exists[db]) return true;
  const [{ t }] = await sql("select to_regclass('public.surveys')::text as t");
  if (t) exists[db] = true;
  return !!t;
}

const ms = (v) => (v == null ? null : new Date(v).getTime());
function toTs(v, label) {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new SurveyAdminError(`${label}的時間格式不對`);
  return new Date(t).toISOString();
}

// 列表用的狀態：draft／scheduled（還沒開始）／active／ended（manual、full、expired）
function stateOf(r, now = Date.now()) {
  if (r.status !== "published") return { state: "draft", reason: null };
  if (r.ended_at) return { state: "ended", reason: r.ended_reason || "manual" };
  if (r.ends_at && ms(r.ends_at) <= now) return { state: "ended", reason: "expired" };
  if (r.max_responses != null && r.completed_count >= r.max_responses) return { state: "ended", reason: "full" };
  if (r.starts_at && ms(r.starts_at) > now) return { state: "scheduled", reason: null };
  return { state: "active", reason: null };
}
function rowOut(r) {
  return {
    id: r.id, name: r.name, def: r.def, status: r.status, ...stateOf(r),
    startsAt: ms(r.starts_at), endsAt: ms(r.ends_at), maxResponses: r.max_responses, publishedAt: ms(r.published_at),
    endedAt: ms(r.ended_at), endedReason: r.ended_reason, completed: r.completed_count, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
    started: r.started == null ? undefined : Number(r.started), shown: r.shown == null ? undefined : Number(r.shown),
  };
}

export async function listSurveys() {
  if (!(await hasTables())) return [];
  // started：開始作答的份數；shown：出現過的人數（不同 response_id）
  return (await sql(`select s.*, (select count(*) from survey_responses r where r.survey_id = s.id) as started,
      (select count(distinct e.response_id) from survey_events e where e.survey_id = s.id and e.kind = 'shown') as shown
    from surveys s order by s.created_at desc, s.id`)).map(rowOut);
}
export async function getSurvey(id) {
  if (!(await hasTables())) return null;
  const r = (await sql("select * from surveys where id = $1", [String(id || "")]))[0];
  return r ? rowOut(r) : null;
}

// 檢查定義；publish：發布前的完整檢查（目標語言的文字要齊）
export function checkDefinition(def, publish) {
  const errs = Core.validateDefinition(def, { publish: !!publish });
  // text：給人看的寫法（流程圖上的題號、欄位中文名），後台與 CLI 顯示用；path、message 照舊
  if (errs.length) throw new SurveyAdminError(`問卷有 ${errs.length} 個地方要修正`, errs.map((e) => ({ ...e, text: Core.describeError(def, e) })));
}

// 新增或更新草稿：{ id, name, def, startsAt, endsAt, maxResponses }。已發布的不能改
export async function saveDraft(input) {
  await ensureSurveyTables();
  const s = input || {};
  const def = { ...(s.def || {}), id: s.id };
  checkDefinition(def, false);
  const max = s.maxResponses == null || s.maxResponses === "" ? null : Number(s.maxResponses);
  if (max != null && !(Number.isInteger(max) && max >= 1)) throw new SurveyAdminError("份數上限要是正整數");
  const startsAt = toTs(s.startsAt, "開始"), endsAt = toTs(s.endsAt, "結束");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new SurveyAdminError("結束時間要晚於開始時間");
  const cur = await getSurvey(s.id);
  if (cur && cur.status !== "draft") throw new SurveyAdminError("已發布的問卷不能修改；要改請停止後複製成新問卷");
  const { id, ...content } = def;
  await sql(`insert into surveys (id, name, def, starts_at, ends_at, max_responses) values ($1, $2, $3::jsonb, $4, $5, $6)
    on conflict (id) do update set name = excluded.name, def = excluded.def, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
      max_responses = excluded.max_responses, updated_at = now() where surveys.status = 'draft'`,
    [id, String(s.name || "").slice(0, 200), JSON.stringify(content), startsAt, endsAt, max]);
  return getSurvey(id);
}

// 發布：內容鎖住。沒設開始時間就從現在開始
export async function publishSurvey(id) {
  const cur = await getSurvey(id);
  if (!cur) throw new SurveyAdminError("找不到這份問卷");
  if (cur.status !== "draft") throw new SurveyAdminError("這份問卷已經發布過了");
  checkDefinition({ ...cur.def, id: cur.id }, true);
  if (cur.endsAt && cur.endsAt <= Date.now()) throw new SurveyAdminError("結束時間已經過了");
  await sql(`update surveys set status = 'published', published_at = now(), starts_at = coalesce(starts_at, now()), updated_at = now()
    where id = $1 and status = 'draft'`, [cur.id]);
  return getSurvey(cur.id);
}

// 停止：關掉入口（已經在填的人照樣可以送出）
export async function stopSurvey(id) {
  const cur = await getSurvey(id);
  if (!cur) throw new SurveyAdminError("找不到這份問卷");
  if (cur.status !== "published") throw new SurveyAdminError("草稿不用停止，直接刪除就好");
  if (cur.state === "ended") throw new SurveyAdminError("這份問卷已經結束了");
  await sql("update surveys set ended_at = now(), ended_reason = 'manual', updated_at = now() where id = $1 and ended_at is null", [cur.id]);
  return getSurvey(cur.id);
}

// 刪除：只有草稿可以刪（發布過的有作答，留著）
export async function deleteDraft(id) {
  const cur = await getSurvey(id);
  if (!cur) throw new SurveyAdminError("找不到這份問卷");
  if (cur.status !== "draft") throw new SurveyAdminError("發布過的問卷不能刪除，只能停止");
  await sql("delete from surveys where id = $1 and status = 'draft'", [cur.id]);
}

// 複製成新草稿（新 id）：內容照抄，期間與份數上限不抄
export async function copySurvey(id, newId) {
  const cur = await getSurvey(id);
  if (!cur) throw new SurveyAdminError("找不到這份問卷");
  if (await getSurvey(newId)) throw new SurveyAdminError(`id「${newId}」已經有問卷了`);
  return saveDraft({ id: newId, name: `${cur.name}（複本）`, def: cur.def });
}

// 複製到另一個環境（通常是測試 → 正式），成為那邊的草稿；那邊要另外發布
export async function copyToEnv(id, targetEnv) {
  if (!DB_ENVS.includes(targetEnv)) throw new SurveyAdminError(`不認得的環境：${targetEnv}`);
  if (targetEnv === currentDb()) throw new SurveyAdminError("來源與目標是同一個環境");
  const cur = await getSurvey(id);
  if (!cur) throw new SurveyAdminError("找不到這份問卷");
  return withDb(targetEnv, async () => {
    if (await getSurvey(cur.id)) throw new SurveyAdminError(`${targetEnv === "prod" ? "正式" : "測試"}環境已經有 id「${cur.id}」的問卷`);
    return saveDraft({ id: cur.id, name: cur.name, def: cur.def, startsAt: cur.startsAt && cur.startsAt > Date.now() ? cur.startsAt : null, endsAt: cur.endsAt, maxResponses: cur.maxResponses });
  });
}

// 一次性的結構遷移（跳題 showIf → 流程圖 next，scripts/surveys.mjs migrate-flow）：連已發布的問卷也直接換定義。
// 只能用在「意思完全一樣」的轉換（呼叫端先過 survey-flow-migrate.mjs 的等價檢查）；資料庫裡的定義跟讀到的不一樣（中途被改過）就不寫
export async function writeMigratedDef(id, oldDef, newDef) {
  const errs = Core.checkFlow(newDef);
  if (errs.length) throw new SurveyAdminError(`「${id}」轉換後的流程圖有問題`, errs.map((e) => ({ ...e, text: Core.describeError(newDef, e) })));
  const { id: _a, ...oldContent } = oldDef;
  const { id: _b, ...content } = newDef;
  const rows = await sql("update surveys set def = $2::jsonb, updated_at = now() where id = $1 and def = $3::jsonb returning id",
    [String(id), JSON.stringify(content), JSON.stringify(oldContent)]);
  if (!rows.length) throw new SurveyAdminError(`「${id}」在讀取之後被改過，沒有寫入；請重跑`);
}

// ── 結果（後台的結果頁；統計在畫面算，這裡只把資料撈出來）──
// ── 可疑作答（只標記、結果頁預設排除，不刪、不拒收）──
// 目的是擋「寫程式大量灌票」，又不能誤判宿舍、公司、電信商共用 IP 的正常使用者，所以 IP 只當輔助訊號：
//   · fast     完成得太快：開始到完成 < FAST_MS
//   · no_shown 沒有出現紀錄：找不到這份作答的 shown 事件，或 shown 比完成晚 SHOWN_SLACK_MS 以上（時間對不上）。
//              Firefox 沒同意匿名統計時擴充不送事件（survey.js 的 track），沒有 shown 是正常的，所以 Firefox 不套這條
//   · same_ip  同一個 IP 雜湊、同一份問卷、答案完全一樣、彼此相隔不到 1 小時（連成一串）的完成作答 ≥ SAME_IP_MIN 份：
//              每一串留最早的那份，其他標記（同一個人重裝、換瀏覽器重填時，第一份照算）。同 IP 但答案不同不標；沒有 ip_hash 的不判斷
// 「同一小時同一國家 5 份以上答案完全一樣」（舊規則）不再標記：走最短路徑、答案很常見的正常作答會被系統性排除，只留一個參考數字（dupReference）
export const SUSPECT = { FAST_MS: 8000, SHOWN_SLACK_MS: 60000, SAME_IP_WINDOW_MS: 3600000, SAME_IP_MIN: 2, DUP_REF_MIN: 5 };
export const SUSPECT_REASONS = ["no_shown", "same_ip", "fast"];

// rows：{ responseId, completed, startedAt, completedAt, updatedAt, browser, answers, shownAt, ipHash } → Map(responseId → [原因…])
export function suspectReasons(rows) {
  const out = new Map();
  const add = (id, why) => { const a = out.get(id) || []; if (!a.includes(why)) a.push(why); out.set(id, a); };
  for (const r of rows) {
    if (r.browser !== "firefox" && (r.shownAt == null || (r.completed && r.completedAt != null && r.shownAt > r.completedAt + SUSPECT.SHOWN_SLACK_MS))) add(r.responseId, "no_shown");
  }
  const groups = new Map();
  for (const r of rows) {
    if (!r.completed || !r.ipHash) continue;
    const k = `${r.ipHash}|${JSON.stringify(r.answers || {})}`;
    groups.set(k, (groups.get(k) || []).concat(r));
  }
  for (const list of groups.values()) {
    if (list.length < SUSPECT.SAME_IP_MIN) continue;
    const t = (r) => r.updatedAt ?? r.completedAt ?? r.startedAt;
    list.sort((a, b) => t(a) - t(b));
    let run = [list[0]];
    const flush = () => { if (run.length >= SUSPECT.SAME_IP_MIN) run.slice(1).forEach((r) => add(r.responseId, "same_ip")); };
    for (let i = 1; i < list.length; i++) {
      if (t(list[i]) - t(list[i - 1]) <= SUSPECT.SAME_IP_WINDOW_MS) run.push(list[i]);
      else { flush(); run = [list[i]]; }
    }
    flush();
  }
  for (const r of rows) if (r.completed && r.completedAt && r.completedAt - r.startedAt < SUSPECT.FAST_MS) add(r.responseId, "fast");
  // 原因照固定順序排
  for (const [id, a] of out) out.set(id, SUSPECT_REASONS.filter((x) => a.includes(x)));
  return out;
}
// 參考數字（不標記、不排除）：同一小時、同一國家、答案完全一樣的完成作答，一組 ≥ DUP_REF_MIN 份的總份數
export function dupReference(rows) {
  const groups = new Map();
  rows.filter((r) => r.completed).forEach((r) => {
    const k = `${r.country}|${Math.floor(r.startedAt / 3600000)}|${JSON.stringify(r.answers || {})}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  });
  return [...groups.values()].filter((n) => n >= SUSPECT.DUP_REF_MIN).reduce((a, b) => a + b, 0);
}

// ip_hash 欄位在不在（正式環境沒跑過新的 ensureSurveyTables 時還沒有；只讀的結果頁不改 schema）
const ipCol = {};
async function hasIpHash() {
  const db = currentDb();
  if (ipCol[db]) return true;
  const rows = await sql("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'survey_responses' and column_name = 'ip_hash'");
  if (rows.length) ipCol[db] = true;
  return rows.length > 0;
}

// 作答：每一份（含填到一半的）。email 只在 withEmail 時給（Email 分頁按「顯示」才拿）。
// suspect：可疑的原因（見上面）；ip_hash 只在這裡用來判斷，不回傳（不出現在畫面、CSV）
export async function surveyResponses(id, withEmail) {
  if (!(await hasTables())) return [];
  const ip = await hasIpHash();
  const raw = await sql(`select r.response_id, r.answers, ${withEmail ? "r.email" : "(r.email is not null) as has_email"}, r.country, r.entry, r.browser, r.ext_version, r.lang,
      r.install_days, r.custom_nodes, r.completed, r.after_end, r.started_at, r.completed_at, r.created_at, r.updated_at, ${ip ? "r.ip_hash" : "null::text as ip_hash"},
      s.shown_at
    from survey_responses r
    left join (select response_id, min(at) as shown_at from survey_events where survey_id = $1 and kind = 'shown' group by response_id) s on s.response_id = r.response_id
    where r.survey_id = $1 order by r.created_at`, [String(id || "")]);
  const rows = raw.map((r) => ({
    responseId: r.response_id, answers: r.answers || {}, email: withEmail ? r.email : undefined, hasEmail: withEmail ? !!r.email : !!r.has_email,
    country: r.country, entry: r.entry, browser: r.browser, extVersion: r.ext_version, lang: r.lang, installDays: r.install_days,
    customNodes: !!r.custom_nodes, completed: !!r.completed, afterEnd: !!r.after_end,
    startedAt: Number(r.started_at || r.created_at), completedAt: r.completed_at == null ? null : Number(r.completed_at),
    updatedAt: Number(r.updated_at || r.created_at), shownAt: r.shown_at == null ? null : Number(r.shown_at),
  }));
  const flags = suspectReasons(rows.map((r, i) => ({ ...r, ipHash: raw[i].ip_hash || null })));
  return rows.map((r) => ({ ...r, suspect: flags.get(r.responseId) || [] }));
}

// 事件彙總：出現（依入口）、每一頁（人數、平均與中位數停留）、在第幾頁關掉、完成；同一份作答出現幾次
export async function surveyEventStats(id) {
  if (!(await hasTables())) return { shown: [], pages: [], closed: [], completed: 0, repeats: [] };
  const sid = String(id || "");
  const [shown, pages, closed, completed, repeats] = await Promise.all([
    sql("select entry, count(*)::int as n, count(distinct response_id)::int as people from survey_events where survey_id = $1 and kind = 'shown' group by entry order by entry", [sid]),
    sql(`select page, question, count(distinct response_id)::int as people, count(*)::int as n,
        round(avg(ms))::int as avg_ms, percentile_cont(0.5) within group (order by ms)::int as median_ms
      from survey_events where survey_id = $1 and kind = 'page' and page is not null group by page, question order by page, question`, [sid]),
    sql("select page, count(distinct response_id)::int as people from survey_events where survey_id = $1 and kind = 'closed' group by page order by page", [sid]),
    sql("select count(distinct response_id)::int as people from survey_events where survey_id = $1 and kind = 'completed'", [sid]),
    sql(`select times, count(*)::int as people from (select response_id, count(*)::int as times from survey_events
        where survey_id = $1 and kind = 'shown' group by response_id) t group by times order by times`, [sid]),
  ]);
  return { shown, pages, closed, completed: completed[0]?.people || 0, repeats };
}

// 觸發機會（所有問卷共用）：最近 days 天，每天 × 觸發方式 × 結果
// 觸發機會加上還沒彙總回 Neon 的今天、昨天（直接查 Analytics Engine；要 .env.local 的 BCS_CF_ACCOUNT_ID、BCS_CF_ANALYTICS_TOKEN，
// 雲端後台沒有這兩個就只有 Neon 的歷史）。同一天兩邊都有時用 Analytics Engine 的（比較新）
export async function triggerStatsWithRecent(days = 60) {
  const rows = await triggerStats(days);
  const ae = aeFromEnv();
  if (!ae) return rows;
  try {
    const recent = await recentTriggers(ae, TELEMETRY_DATASETS[currentDb()]);
    const fresh = new Set(recent.map((r) => r.day));
    return rows.filter((r) => !fresh.has(r.day)).concat(recent);
  } catch (e) {
    console.error("triggerStats: Analytics Engine", e.message);
    return rows;
  }
}

export async function triggerStats(days = 30) {
  if (!(await hasTables())) return [];
  return sql(`select day, trigger, result, sum(n)::int as n from survey_trigger_daily
    where day >= to_char(now() - make_interval(days => $1::int), 'YYYY-MM-DD') group by day, trigger, result order by day, trigger, result`, [days]);
}
