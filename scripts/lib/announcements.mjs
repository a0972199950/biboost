// 擴充的公告（Neon 的 announcements；表建在 lotteries.mjs 的 ensureTable，2026-11-21 公告改版加的欄位在這裡的 ensureAnnouncementSchema）。
// 2026-11-21 起公告一律在後台手動新增（新增抽獎不再自動建公告），先選類型：
//   · type = 'html'：一般公告。前綴（可省略）、標題、點開後的 HTML
//   · type = 'lottery'：抽獎公告，掛一個抽獎 v2（lottery_v2_id）。後台填前綴、標題；點開的內容由擴充依抽獎資料組（src/lottery-text.js），
//     沒有內文。舊版擴充不看前綴／標題，照舊用抽獎資料自己組（所以 API 照舊附 lottery metadata）
//   · type = 'survey'：問卷公告，掛一份問卷（survey_id）。後台填前綴、標題；點開在單獨的視窗開問卷（src/survey-window.html），沒有內文。
//     舊版擴充不認得這個類型，會略過（見 tools/report-worker/src/snapshots.js 的說明）
// 共同欄位：前綴、標題、HTML 都是 { 語言: 文字 }，只填一種語言也行（擴充依 介面語言 → en → zh-TW → 任一 的順序退回）；
// countries 空＝所有國家；starts_at／ends_at 是公告自己的期間（空＝不限，ends_at 不含）。抽獎、問卷公告一定要有開始時間。
// 連結的抽獎或問卷已經結束、公告還在期間內：照樣顯示，點開說「已經結束」。
// 舊的自動抽獎公告（沒有自己的標題與期間，legacy）：照舊跟著抽獎（抽獎進行中才顯示），listLegacyLotteryAnnouncements／deleteLegacy 用來清掉。
// 擴充透過 report worker 的 GET /v2/announcements 讀取（舊版也有讀 /v1）。錯誤一律丟 AnnouncementError（訊息給人看的中文）。
import { currentDb, ensureTable, sql } from "./lotteries.mjs";
import { listSurveys } from "./surveys.mjs";

export const LANGS = ["zh-TW", "zh-CN", "en", "ja", "ko"];
export const TYPES = ["html", "lottery", "survey"];
const SURVEY_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/; // 同 src/survey-core.js 的問卷 id

export class AnnouncementError extends Error {}

// 改版加的欄位與類型（只加不刪，舊版 report worker 不受影響）。存公告時才跑（看列表不改 schema），每個資料庫一次。
// 正式環境上線時用 npm run announcements -- schema --env prod 先跑（report worker 的快照會讀這些欄位）
const schemaReady = {};
export function ensureAnnouncementSchema() {
  const db = currentDb();
  schemaReady[db] ||= (async () => {
    await ensureTable();
    // 問卷 id：surveys 表在同一個資料庫，但正式環境可能還沒建，所以不設外鍵
    await sql(`alter table announcements
      add column if not exists survey_id text,
      add column if not exists starts_at timestamptz,
      add column if not exists ends_at timestamptz`);
    // 類型多了 'survey'：舊表的 check 只有 lottery／html，換掉（已經換過就不動，免得每次都鎖表）
    await sql(`do $$ begin
      if not exists (select 1 from pg_constraint where conrelid = 'announcements'::regclass and conname = 'announcements_type_check'
                     and pg_get_constraintdef(oid) like '%survey%') then
        alter table announcements drop constraint if exists announcements_type_check;
        alter table announcements add constraint announcements_type_check check (type in ('lottery', 'html', 'survey'));
      end if;
    end $$`);
  })().catch((e) => { schemaReady[db] = null; throw e; });
  return schemaReady[db];
}

// 看的動作不改 schema：表不存在＝沒有公告；改版的欄位還沒加（正式環境上線前）就當作都是空的
async function readableColumns() {
  const [{ t }] = await sql("select to_regclass('public.announcements')::text as t");
  if (!t) return null;
  const rows = await sql(`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'announcements' and column_name in ('survey_id', 'starts_at', 'ends_at', 'lottery_v2_id')`);
  return new Set(rows.map((r) => r.column_name));
}

// { 語言: 文字 } 只留認得的語言、去掉空白；全空回 null
function langMap(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const l of LANGS) if (typeof v[l] === "string" && v[l].trim()) out[l] = v[l].trim();
  return Object.keys(out).length ? out : null;
}
// 時間：毫秒或 ISO 字串；空＝null
function toMs(v, label) {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new AnnouncementError(`${label}的時間格式不對`);
  return t;
}

// 檢查並整理公告（三種類型共用）；不合格丟 AnnouncementError。
// input：{ type, prefix, title, html（一般公告）, countries, lotteryId（抽獎公告）, surveyId（問卷公告）, startsAt, endsAt }
// 沒給 type 的當作一般公告（改版前的後台只送一般公告）
export function validateAnnouncement(a) {
  const fail = (msg) => { throw new AnnouncementError(msg); };
  if (!a || typeof a !== "object") fail("格式錯誤");
  const type = a.type == null || a.type === "" ? "html" : a.type;
  if (!TYPES.includes(type)) fail("類型（type）要是 html（一般）、lottery（抽獎）或 survey（問卷）");
  const title = langMap(a.title);
  if (!title) fail("標題（title）至少要填一種語言");
  const countries = Array.isArray(a.countries) ? a.countries.map((c) => String(c).trim().toUpperCase()).filter(Boolean) : [];
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) fail("國家（countries）要是兩碼大寫國家代碼，例如 TW");
  const startsAt = toMs(a.startsAt, "開始"), endsAt = toMs(a.endsAt, "結束");
  if (startsAt != null && endsAt != null && endsAt <= startsAt) fail("結束時間要晚於開始時間");
  const out = { type, prefix: langMap(a.prefix), title, html: null, countries: [...new Set(countries)], lotteryId: null, surveyId: null, startsAt, endsAt };
  if (type === "html") {
    out.html = langMap(a.html);
    if (!out.html) fail("點開後的內容（html）至少要填一種語言");
    return out;
  }
  // 抽獎、問卷公告：沒有內文；一定要有開始時間（沒有自己期間的抽獎公告是改版前自動建的，規則不同）
  if (startsAt == null) fail("抽獎、問卷公告要設開始時間");
  if (type === "lottery") {
    const id = Number(a.lotteryId);
    if (!(Number.isInteger(id) && id > 0)) fail("請選一個抽獎");
    out.lotteryId = id;
  } else {
    const id = String(a.surveyId || "").trim();
    if (!SURVEY_ID_RE.test(id)) fail("請選一份問卷");
    out.surveyId = id;
  }
  return out;
}
// 舊名（改版前只有一般公告）
export const validateHtmlAnnouncement = (a) => validateAnnouncement({ ...a, type: "html" });

// 抽獎公告：掛在抽獎 v2（lottery_v2_id，新版擴充看的）就用 v2 的標題與狀態；只掛在 v1（lottery_id）的只有舊版擴充看得到
function rowSql(cols) {
  const has = (c) => cols.has(c);
  const extra = [
    has("survey_id") ? "a.survey_id" : "null::text as survey_id",
    has("starts_at") ? "(extract(epoch from a.starts_at) * 1000)::float8 as starts_ms" : "null::float8 as starts_ms",
    has("ends_at") ? "(extract(epoch from a.ends_at) * 1000)::float8 as ends_ms" : "null::float8 as ends_ms",
  ].join(", ");
  return `select a.id, a.type, a.lottery_id, a.lottery_v2_id, a.prefix, a.title, a.html, a.countries, ${extra},
    to_char(a.created_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as created,
    to_char(a.updated_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as updated,
    v.title as lottery_v2_title, l.title as lottery_title, coalesce(v.country, l.country) as lottery_country,
    (extract(epoch from v.starts_at) * 1000)::float8 as lottery_starts_ms, (extract(epoch from least(v.ended_at, v.ends_at)) * 1000)::float8 as lottery_ends_ms,
    case when v.id is not null then
           case when v.ended_at is not null then 'ended_early' when now() < v.starts_at then 'upcoming'
                when now() >= v.ends_at then 'ended' else 'active' end
         when l.id is null then null when l.ended_at is not null then 'ended_early' when now() < l.starts_at then 'upcoming'
         when now() >= l.ends_at then 'ended' else 'active' end as lottery_status
  from announcements a left join lotteries l on l.id = a.lottery_id left join lotteries_v2 v on v.id = a.lottery_v2_id`;
}

// 公告自己的期間：upcoming（還沒開始）／active／ended
function periodState(startsAt, endsAt, now) {
  if (startsAt != null && now < startsAt) return "upcoming";
  if (endsAt != null && now >= endsAt) return "ended";
  return "active";
}
const num = (v) => (v == null ? null : Number(v));

// surveys：{ <id>: { name, state, reason } }（問卷公告用；沒有 surveys 表時是 {}）
function rowToAnnouncement(r, surveys, now = Date.now()) {
  const startsAt = num(r.starts_ms), endsAt = num(r.ends_ms);
  const base = {
    id: r.id, type: r.type, created: r.created, updated: r.updated, prefix: r.prefix || {}, title: r.title || {}, html: r.html || {},
    countries: r.countries || [], startsAt, endsAt, period: periodState(startsAt, endsAt, now),
  };
  const inPeriod = base.period === "active";
  if (r.type === "lottery") {
    const v2 = r.lottery_v2_id != null;
    // 改版前自動建的（沒有自己的期間與標題）：跟著抽獎，前綴與標題由擴充依抽獎資料組，國家是抽獎的國家
    const legacy = startsAt == null && endsAt == null;
    const lotteryTitle = v2 ? r.lottery_v2_title || {} : { "zh-TW": r.lottery_title };
    return {
      ...base, legacy, lotteryId: v2 ? r.lottery_v2_id : r.lottery_id, lotteryHref: v2 ? `/lotteries/${currentDb()}/${r.lottery_v2_id}` : `/lotteries/${currentDb()}`,
      legacyOnly: !v2, lotteryTitle, lotteryCountry: r.lottery_country || null, lotteryStatus: r.lottery_status,
      lotteryStartsAt: num(r.lottery_starts_ms), lotteryEndsAt: num(r.lottery_ends_ms),
      title: legacy ? lotteryTitle : base.title, countries: legacy ? (r.lottery_country ? [r.lottery_country] : []) : base.countries,
      // 擴充目前會不會顯示：legacy 只在抽獎進行中；有自己期間的看公告期間（抽獎結束了照樣顯示，點開說已經結束）
      // （只掛 v1 的只有舊版擴充看得到，新版不顯示）
      visible: v2 && (legacy ? r.lottery_status === "active" : inPeriod),
      targetEnded: r.lottery_status === "ended" || r.lottery_status === "ended_early",
    };
  }
  if (r.type === "survey") {
    const s = surveys[r.survey_id] || null;
    return {
      ...base, surveyId: r.survey_id, surveyName: s ? s.name : null, surveyState: s ? s.state : "missing", surveyReason: s ? s.reason : null,
      visible: inPeriod, targetEnded: !s || s.state === "ended" || s.state === "draft",
    };
  }
  return { ...base, visible: inPeriod, targetEnded: false };
}

async function surveyMap(rows) {
  if (!rows.some((r) => r.type === "survey")) return {};
  const [{ t }] = await sql("select to_regclass('public.surveys')::text as t");
  if (!t) return {};
  const out = {};
  for (const s of await listSurveys()) out[s.id] = { name: s.name || s.id, state: s.state, reason: s.reason };
  return out;
}

// 全部公告，新的在前；visible＝新版擴充目前會不會顯示
export async function listAnnouncements() {
  const cols = await readableColumns();
  if (!cols) return [];
  const rows = await sql(`${rowSql(cols)} order by a.created_at desc, a.id desc`);
  const surveys = await surveyMap(rows);
  return rows.map((r) => rowToAnnouncement(r, surveys));
}

export async function getAnnouncement(id) {
  const cols = await readableColumns();
  if (!cols) return null;
  const rows = await sql(`${rowSql(cols)} where a.id = $1`, [id]);
  if (!rows.length) return null;
  return rowToAnnouncement(rows[0], await surveyMap(rows));
}

// 連結的對象要存在於「同一個環境」的資料庫（正式的公告只能連正式的抽獎／問卷，測試的只能連測試的；查詢在 withDb(env) 裡，
// 所以只查得到同一個環境的）。後台畫面的下拉也只列同一個環境的，這裡是伺服器端的把關。一個抽獎只能有一則公告（lottery_v2_id 是 unique）
const envName = () => (currentDb() === "staging" ? "測試環境" : "正式環境");
async function checkTarget(a, selfId) {
  if (a.type === "lottery") {
    const rows = await sql("select id from lotteries_v2 where id = $1", [a.lotteryId]);
    if (!rows.length) throw new AnnouncementError(`${envName()}沒有抽獎 #${a.lotteryId}（公告只能連同一個環境的抽獎）`);
    const dup = await sql("select id from announcements where lottery_v2_id = $1 and id <> $2", [a.lotteryId, selfId || 0]);
    if (dup.length) throw new AnnouncementError(`第 ${a.lotteryId} 個抽獎已經有公告（第 ${dup[0].id} 則），一個抽獎只能有一則；要改請編輯那一則`);
  }
  if (a.type === "survey") {
    const [{ t }] = await sql("select to_regclass('public.surveys')::text as t");
    const rows = t ? await sql("select id from surveys where id = $1", [a.surveyId]) : [];
    if (!rows.length) throw new AnnouncementError(`${envName()}沒有問卷「${a.surveyId}」（公告只能連同一個環境的問卷）`);
  }
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
function rowParams(a) {
  return [a.type, a.prefix && JSON.stringify(a.prefix), JSON.stringify(a.title), a.html && JSON.stringify(a.html),
    a.countries.length ? a.countries : null, a.lotteryId, a.surveyId, iso(a.startsAt), iso(a.endsAt)];
}

// 新增，回傳 id
export async function addAnnouncement(input) {
  const a = validateAnnouncement(input);
  await ensureAnnouncementSchema();
  await checkTarget(a, null);
  const rows = await sql(
    `insert into announcements (type, prefix, title, html, countries, lottery_v2_id, survey_id, starts_at, ends_at)
     values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::text[], $6, $7, $8::timestamptz, $9::timestamptz) returning id`,
    rowParams(a),
  );
  return rows[0].id;
}
export const addHtmlAnnouncement = (input) => addAnnouncement({ ...input, type: "html" });

// 覆寫（類型也可以換）；找不到回 false。v1 的 lottery_id 不動（只有舊版擴充看得到的那則）
export async function updateAnnouncement(id, input) {
  const a = validateAnnouncement(input);
  await ensureAnnouncementSchema();
  await checkTarget(a, id);
  const rows = await sql(
    `update announcements set type = $2, prefix = $3::jsonb, title = $4::jsonb, html = $5::jsonb, countries = $6::text[],
       lottery_v2_id = $7, survey_id = $8, starts_at = $9::timestamptz, ends_at = $10::timestamptz, updated_at = now()
     where id = $1 returning id`,
    [id, ...rowParams(a)],
  );
  return rows.length > 0;
}

// 刪除（任何類型）；找不到回 false
export async function deleteAnnouncement(id) {
  if (!(await readableColumns())) return false;
  const rows = await sql("delete from announcements where id = $1 returning id", [id]);
  return rows.length > 0;
}
export const deleteHtmlAnnouncement = deleteAnnouncement;

// 改版前自動建的抽獎公告（沒有自己的標題與期間）：上線時刪掉，之後在後台手動重新發
export async function listLegacyLotteryAnnouncements() {
  const cols = await readableColumns();
  if (!cols) return [];
  const where = ["a.type = 'lottery'", "a.title is null", ...(cols.has("starts_at") ? ["a.starts_at is null", "a.ends_at is null"] : [])].join(" and ");
  return (await sql(`${rowSql(cols)} where ${where} order by a.id`)).map((r) => rowToAnnouncement(r, {}));
}
export async function deleteLegacyLotteryAnnouncements(ids) {
  if (!ids.length) return [];
  const cols = await readableColumns();
  const where = ["type = 'lottery'", "title is null", ...(cols.has("starts_at") ? ["starts_at is null", "ends_at is null"] : [])].join(" and ");
  return (await sql(`delete from announcements where id = any($1::int[]) and ${where} returning id`, [ids])).map((r) => r.id);
}
