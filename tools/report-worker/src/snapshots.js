/**
 * KV 快照：「所有安裝都會打、全天都有人打」的 GET 不能每個請求都查 Neon。
 * Neon 閒置 5 分鐘才休眠，這些端點每幾分鐘就有人打，資料庫就會 24 小時開著、照小時計費。
 *
 * 做法：後台與 CLI 改了資料就把整份「原始資料」寫進 KV（scripts/lib/kv-snapshot.mjs），worker 只讀 KV，
 * 「進行中」這類跟時間有關的判斷在 worker 裡用 Date.now() 做（快照裡放還沒結束的全部，連同起訖時間）。
 * 這個檔案是純 ESM、不依賴 Node：worker、本機後台、雲端後台（biboost.app/admin）、CLI 共用同一份。
 *
 *   名稱            內容（data）                                                          worker 用在
 *   announcements  { v1: [公告], v2: [公告] }，公告期間還沒結束的（含還沒開始；格式見         /v1、/v2/announcements
 *                  announcementItem）。問卷公告只在 v2
 *   lotteries      { v1: [抽獎], v2: [抽獎 v2] }，還沒結束的（含還沒開始）                  /v1、/v2/lotteries
 *   features       { <key>: data }（Neon 的 features；沒有表時沿用 settings.donate_enabled） /v1/features、贊助開關
 *   surveys        [{ id, def, startsAt, endsAt }]，已發布、沒停止、沒到期、沒額滿          /v2/surveys
 *
 * KV 的 key：snap:<名稱>:<prod|staging>。正式與測試的 worker 綁同一個 KV namespace（RATE_KV），所以 key 要分環境；
 * worker 依 env.SNAPSHOT_ENV（測試環境設 "staging"）決定讀哪一份。值是 JSON：{ v: 1, at: 寫入時間（毫秒）, data }。
 */
export const SNAPSHOT_NAMES = ["announcements", "lotteries", "features", "surveys"];
const FORMAT = 1;

// 改到哪張表 → 哪些快照要重寫。抽獎會出現在公告裡，所以改抽獎也要重寫公告
export const TABLE_SNAPSHOTS = {
  announcements: ["announcements"],
  lotteries: ["lotteries", "announcements"],
  lotteries_v2: ["lotteries", "announcements"],
  features: ["features"],
  surveys: ["surveys"],
};
// （settings 不在上面：只有 features 表還不存在時才沿用 settings.donate_enabled，各環境都已經有 features 表；
//   settings 也放測速報告快照這類跟功能開關無關的設定，算進去會讓不相干的動作也去寫 KV。每日 Cron 會整份重建當保底）

// SQL 裡每一個改資料的動作（insert into／update／delete from／truncate／merge into）後面的表名，可以帶 schema（public.）、
// 中間夾註解。只改 schema（alter table … add column if not exists，每次啟動都會跑）不算。
// 「on conflict … do update set」的 update 後面是 set，不是表名，不會誤判
// 先拿掉字串常值（裡面的 -- 不是註解）與註解，再找寫入
const STRINGS_RE = /'(?:[^']|'')*'/g;
const COMMENTS_RE = /\/\*[\s\S]*?\*\/|--[^\n]*/g;
const WRITE_RE = /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(?:only\s+)?(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;
// truncate 可以一次好幾張表：truncate a, public.b restart identity
const TRUNCATE_RE = /\btruncate\s+(?:table\s+)?(?:only\s+)?((?:"?[a-z_][a-z0-9_.]*"?\s*,\s*)*"?[a-z_][a-z0-9_.]*"?)/gi;

// 這段 SQL 會讓哪些快照過期
export function snapshotsTouchedBy(query) {
  const out = new Set();
  const add = (table) => { for (const s of TABLE_SNAPSHOTS[table.replace(/"/g, "").split(".").pop().toLowerCase()] || []) out.add(s); };
  const text = String(query || "").replace(STRINGS_RE, "''").replace(COMMENTS_RE, " ");
  for (const m of text.matchAll(WRITE_RE)) add(m[1]);
  for (const m of text.matchAll(TRUNCATE_RE)) for (const t of m[1].split(",")) add(t.trim());
  return out;
}

// 環境一定要明確：認不得就丟錯（寧可這個請求失敗，也不要讀錯或把測試資料寫進正式的 key）
const ENV_NAMES = ["prod", "staging"];
export function envNameOf(env) {
  const v = env && env.SNAPSHOT_ENV;
  if (!ENV_NAMES.includes(v)) throw new Error(`SNAPSHOT_ENV 要是 prod 或 staging（現在是 ${JSON.stringify(v)}）`);
  return v;
}
export function snapshotKey(name, envName) {
  if (!ENV_NAMES.includes(envName)) throw new Error(`不認得的環境：${JSON.stringify(envName)}`);
  return `snap:${name}:${envName}`;
}
export function encodeSnapshot(data, at = Date.now()) { return JSON.stringify({ v: FORMAT, at, data }); }
// 每種快照的形狀；不對（例如被別的程式寫壞）就當作沒有
const SHAPES = {
  announcements: (d) => !!d && Array.isArray(d.v1) && Array.isArray(d.v2),
  lotteries: (d) => !!d && Array.isArray(d.v1) && Array.isArray(d.v2),
  features: (d) => !!d && typeof d === "object" && !Array.isArray(d),
  surveys: (d) => Array.isArray(d),
};
export function decodeSnapshot(v, name) {
  const o = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch (e) { return null; } })() : v;
  if (!(o && typeof o === "object" && o.v === FORMAT && "data" in o)) return null;
  if (name && SHAPES[name] && !SHAPES[name](o.data)) return null;
  return o;
}

// ── 從 Neon 建快照（q = async (sql, params) => rows）──
// 只有「這張表不存在」（Postgres 的 relation "<表>" does not exist，例如還沒建表的新環境）才當作空的；其他錯誤（欄位不存在、
// 資料庫不存在、連不上）一律丟出來，不能把空的寫進 KV。info.missing 記下有沒有哪一段被當成空的
function missingTable(e, tables) {
  const m = /relation \\?"(?:public\.)?([a-z_][a-z0-9_]*)\\?" does not exist/.exec(String(e && e.message));
  return !!m && tables.includes(m[1]);
}
async function rowsOrEmpty(q, sql, params, tables, info) {
  try { return await q(sql, params); } catch (e) {
    if (!missingTable(e, tables)) throw e;
    if (info) info.missing = true;
    return [];
  }
}

// 抽獎欄位（lotteries 的別名 l）：日期是台灣時間；startsAt / endsAt 是毫秒時間戳（endsAt 不含，即結束日隔天 00:00 台灣時間；
// 提前結束的是結束那一刻，抽獎公告在抽獎結束後還在期間內時會帶著它，舊版擴充靠 endsAt 判斷不顯示）
const LOTTERY_FIELDS = `l.id as l_id, l.title as l_title, l.country as l_country, l.prize_amount::float8 as l_amount, l.currency as l_currency,
    l.gift_cards as l_gift_cards, l.isps as l_isps, l.winners as l_winners, l.draw_days as l_draw_days,
    to_char(l.starts_at at time zone 'Asia/Taipei', 'YYYY-MM-DD') as l_start_date,
    to_char(l.ends_at at time zone 'Asia/Taipei' - interval '1 day', 'YYYY-MM-DD') as l_end_date,
    to_char(l.ends_at at time zone 'Asia/Taipei' - interval '1 day' + make_interval(days => coalesce(l.draw_days, 7)), 'YYYY-MM-DD') as l_draw_by,
    (extract(epoch from l.starts_at) * 1000)::float8 as l_starts_ms, (extract(epoch from least(l.ended_at, l.ends_at)) * 1000)::float8 as l_ends_ms`;
// 還沒結束（含還沒開始）；「已經開始」在 worker 用 Date.now() 判斷
const LOTTERY_NOT_OVER = "l.ended_at is null and l.country is not null and l.ends_at > now()";

export function lotteryItem(r) {
  return {
    id: r.l_id, title: r.l_title, country: r.l_country, prize: { amount: r.l_amount, currency: r.l_currency, giftCards: r.l_gift_cards || [] },
    winners: r.l_winners, isps: r.l_isps || [], drawDays: r.l_draw_days == null ? 7 : r.l_draw_days,
    startDate: r.l_start_date, endDate: r.l_end_date, drawBy: r.l_draw_by, startsAt: r.l_starts_ms, endsAt: r.l_ends_ms
  };
}

// 抽獎 v2 的欄位（lotteries_v2 的別名 v），日期規則同 LOTTERY_FIELDS
const LOTTERY_V2_FIELDS = `v.id as v_id, v.title as v_title, v.country as v_country, v.currency as v_currency, v.gift_cards as v_gift_cards,
    v.note as v_note, v.isps as v_isps, v.winners as v_winners, v.draw_days as v_draw_days,
    to_char(v.starts_at at time zone 'Asia/Taipei', 'YYYY-MM-DD') as v_start_date,
    to_char(v.ends_at at time zone 'Asia/Taipei' - interval '1 day', 'YYYY-MM-DD') as v_end_date,
    to_char(v.ends_at at time zone 'Asia/Taipei' - interval '1 day' + make_interval(days => v.draw_days), 'YYYY-MM-DD') as v_draw_by,
    (extract(epoch from v.starts_at) * 1000)::float8 as v_starts_ms, (extract(epoch from least(v.ended_at, v.ends_at)) * 1000)::float8 as v_ends_ms`;
const LOTTERY_V2_NOT_OVER = "v.ended_at is null and v.ends_at > now()";

// v2 的一筆：跟 v1 一樣，差在 prize 沒有 amount、giftCards 是 [{ name, amount }]，title 是 { 語言: 文字 }，多了 note（{ 語言: HTML } 或 null）
export function lotteryItemV2(r) {
  return {
    id: r.v_id, title: r.v_title, country: r.v_country, prize: { currency: r.v_currency, giftCards: r.v_gift_cards || [] },
    note: r.v_note || null, winners: r.v_winners, isps: r.v_isps || [], drawDays: r.v_draw_days,
    startDate: r.v_start_date, endDate: r.v_end_date, drawBy: r.v_draw_by, startsAt: r.v_starts_ms, endsAt: r.v_ends_ms
  };
}

// 公告的一筆（新版擴充看全部欄位；舊版只認得 type html／lottery，其他欄位不看）：
//   共同：prefix: { 語言: 文字 } | null、title、countries: ["TW"] | null（全部）、startsAt / endsAt：公告自己的期間（毫秒，null＝不限）
//   html     { id, type: "html", prefix, title, html: { 語言: HTML }, countries, startsAt, endsAt }
//   lottery  { id, type: "lottery", lottery: { /v1 或 /v2/lotteries 的一筆 }, prefix, title, countries, startsAt, endsAt }
//            舊版只看 lottery（自己組前綴、標題，國家用 lottery.country，抽獎期間外不顯示）。
//            startsAt、endsAt 都是 null＝改版前自動建的（legacy）：沒有自己的前綴、標題、國家，跟著抽獎顯示
//   survey   { id, type: "survey", surveyId, prefix, title, countries, startsAt, endsAt }（只在 v2；舊版擴充遇到不認得的 type 會略過）
const num = (v) => (v == null ? null : Number(v));
function announcementItem(r, v2) {
  const own = { prefix: r.prefix || null, title: r.title || null, countries: r.countries || null, startsAt: num(r.a_starts_ms), endsAt: num(r.a_ends_ms) };
  if (r.type === "lottery") return { id: r.id, type: "lottery", lottery: v2 ? lotteryItemV2(r) : lotteryItem(r), ...own };
  if (r.type === "survey") return { id: r.id, type: "survey", surveyId: r.survey_id, ...own };
  return { id: r.id, type: "html", prefix: own.prefix, title: r.title || {}, html: r.html || {}, countries: own.countries, startsAt: own.startsAt, endsAt: own.endsAt };
}

// 公告改版（2026-11-21）加的欄位：正式環境的 schema 還沒升級（npm run announcements -- schema）時當作都是空的，
// 快照照舊建得出來（不會因為部署順序讓公告整個壞掉）
async function announcementColumns(q) {
  const rows = await q(`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'announcements' and column_name in ('survey_id', 'starts_at', 'ends_at')`, []);
  return new Set((rows || []).map((r) => r.column_name));
}
// 公告的查詢（v1：抽獎只看 lotteries；v2：只看 lotteries_v2，另外有問卷公告）。
// 快照放「公告自己的期間還沒結束」的（含還沒開始）；legacy 抽獎公告放抽獎還沒結束的；「已經開始」在 worker 判斷（liveAnnouncements）
function announcementSql(cols, v2) {
  const has = cols.has("starts_at") && cols.has("ends_at") && cols.has("survey_id");
  const sel = has
    ? "a.survey_id, (extract(epoch from a.starts_at) * 1000)::float8 as a_starts_ms, (extract(epoch from a.ends_at) * 1000)::float8 as a_ends_ms"
    : "null::text as survey_id, null::float8 as a_starts_ms, null::float8 as a_ends_ms";
  const notOver = has ? "(a.ends_at is null or a.ends_at > now())" : "true";
  const legacy = has ? "(a.starts_at is null and a.ends_at is null)" : "true";
  const t = v2 ? "v" : "l";
  const lotteryOk = `${t}.id is not null and (${legacy} and ${v2 ? LOTTERY_V2_NOT_OVER : LOTTERY_NOT_OVER} or not ${legacy} and ${notOver})`;
  return `select a.id, a.type, a.prefix, a.title, a.html, a.countries, ${sel}, ${v2 ? LOTTERY_V2_FIELDS : LOTTERY_FIELDS}
    from announcements a ${v2 ? "left join lotteries_v2 v on v.id = a.lottery_v2_id" : "left join lotteries l on l.id = a.lottery_id"}
    where (a.type = 'html' and ${notOver}) or (a.type = 'lottery' and ${lotteryOk})${v2 && has ? ` or (a.type = 'survey' and a.survey_id is not null and ${notOver})` : ""}
    order by a.created_at desc, a.id desc`;
}

const BUILDERS = {
  async lotteries(q, info) {
    const [v1, v2] = await Promise.all([
      rowsOrEmpty(q, `select ${LOTTERY_FIELDS} from lotteries l where ${LOTTERY_NOT_OVER} order by l.ends_at, l.id`, [], ["lotteries"], info),
      rowsOrEmpty(q, `select ${LOTTERY_V2_FIELDS} from lotteries_v2 v where ${LOTTERY_V2_NOT_OVER} order by v.ends_at, v.id`, [], ["lotteries_v2"], info),
    ]);
    return { v1: v1.map(lotteryItem), v2: v2.map(lotteryItemV2) };
  },
  // 公告（新的在前）。v2 的抽獎公告只列掛在抽獎 v2 上的（announcements.lottery_v2_id）；問卷公告只在 v2
  async announcements(q, info) {
    const cols = await announcementColumns(q);
    const [v1, v2] = await Promise.all([
      rowsOrEmpty(q, announcementSql(cols, false), [], ["announcements", "lotteries"], info),
      rowsOrEmpty(q, announcementSql(cols, true), [], ["announcements", "lotteries_v2"], info),
    ]);
    return { v1: v1.map((r) => announcementItem(r, false)), v2: v2.map((r) => announcementItem(r, true)) };
  },
  // { <key>: data }。還沒有 features 表時（後台還沒打開過「功能管理」），贊助沿用舊的 settings.donate_enabled
  async features(q, info) {
    try {
      const out = {};
      for (const r of await q("select key, data from features")) out[r.key] = r.data && typeof r.data === "object" ? r.data : {};
      return out;
    } catch (e) {
      if (!missingTable(e, ["features"])) throw e;
      if (info) info.missing = true;
    }
    const rows = await rowsOrEmpty(q, "select value from settings where key = 'donate_enabled'", [], ["settings"], info);
    return rows.length ? { donate: { enabled: rows[0].value !== false } } : {};
  },
  // 已發布、沒停止、沒到期、沒額滿（含還沒開始的；「已經開始」在 worker 判斷）
  async surveys(q, info) {
    return (await rowsOrEmpty(q, `select id, def, (extract(epoch from starts_at) * 1000)::float8 as starts_ms, (extract(epoch from ends_at) * 1000)::float8 as ends_ms
        from surveys where status = 'published' and ended_at is null and (ends_at is null or ends_at > now())
          and (max_responses is null or completed_count < max_responses)
        order by id`, [], ["surveys"], info)).map((r) => ({ id: r.id, def: r.def, startsAt: r.starts_ms == null ? null : Number(r.starts_ms), endsAt: r.ends_ms == null ? null : Number(r.ends_ms) }));
  },
};

// info（可省略）：建完後 info.missing = true 表示有一段因為表不存在被當成空的
export function buildSnapshot(name, q, info) {
  if (!BUILDERS[name]) throw new Error("unknown snapshot: " + name);
  return BUILDERS[name](q, info);
}

// ── worker：依現在時間篩選 ──
const live = (x, now) => !!x && (x.startsAt == null || x.startsAt <= now) && (x.endsAt == null || now < x.endsAt);
export function liveLotteries(items, now) { return (items || []).filter((x) => live(x, now)); }
// 公告：有自己期間的看公告期間（抽獎、問卷結束了照樣給，新版擴充點開說「已經結束」；舊版擴充自己會用 lottery 的期間擋掉）；
// 沒有期間的一般公告一直給；legacy 抽獎公告（沒有自己的期間）跟著抽獎
export function liveAnnouncements(items, now) {
  return (items || []).filter((a) => {
    if (!a) return false;
    if (a.startsAt != null || a.endsAt != null) return live(a, now);
    return a.type !== "lottery" || live(a.lottery, now);
  });
}
export function liveSurveys(rows, now) { return (rows || []).filter((r) => live(r, now)); }

// ── worker：讀快照 ──
// 1. 這個 isolate 的記憶體（平常 60 秒）。
// 2. KV（cacheTtl：邊緣也快取 60 秒）。
//    · KV 讀取出錯（服務有問題）：不退回查 Neon（KV 壞掉時每個請求都查 Neon，資料庫就會整天開著）；
//      有舊的就用舊的（再撐 10 分鐘），沒有就丟錯，呼叫端回 502／503。
//    · KV 確定沒有這份、或內容形狀不對：才往下。
// 3. 這個機房的 Cache API（別的 isolate 剛查過的結果，5 分鐘）。
// 4. 查 Neon 一次（fallback），結果放進記憶體與 Cache API，並寫回 KV。寫回失敗（例如 KV 寫入額度用完）或有表不存在
//    被當成空的：不寫 KV，這個 isolate 10 分鐘內不再查。Neon 也失敗：有舊的就用舊的。
const MEM_MS = 60_000;
const HOLD_MS = 10 * 60_000;
const COLO_S = 300;
const mem = new Map(); // key → { until, data }
export function _resetSnapshotMemory() { mem.clear(); }
const coloCache = () => (typeof caches !== "undefined" && caches && caches.default) || null;
const coloKey = (key) => new Request(`https://snapshot.internal/${encodeURIComponent(key)}`);

export async function readSnapshot(env, name, fallback, now = Date.now()) {
  const key = snapshotKey(name, envNameOf(env));
  const m = mem.get(key);
  if (m && now < m.until) return m.data;
  const keep = (data, ms) => { mem.set(key, { until: now + ms, data }); return data; };

  if (env.RATE_KV) {
    let raw, kvError = null;
    // 用 text 讀、自己解：值不是合法 JSON 時當作「沒有這份」（往下查 Neon 並蓋掉），不要當成 KV 故障一直回錯誤
    try { raw = await env.RATE_KV.get(key, { type: "text", cacheTtl: 60 }); } catch (e) { kvError = e; }
    if (kvError) {
      if (m) return keep(m.data, HOLD_MS);
      throw new Error("snapshot_unavailable " + name);
    }
    const snap = decodeSnapshot(raw, name);
    if (snap) return keep(snap.data, MEM_MS);
  }
  if (!fallback) { if (m) return keep(m.data, MEM_MS); throw new Error("snapshot_missing " + name); }

  const cache = coloCache();
  if (cache) {
    try {
      const hit = await cache.match(coloKey(key));
      if (hit) { const snap = decodeSnapshot(await hit.text(), name); if (snap) return keep(snap.data, MEM_MS); }
    } catch (e) { /* 快取壞了就往下查 */ }
  }

  const info = {};
  let data;
  try {
    data = await fallback(info);
  } catch (e) {
    if (m) return keep(m.data, HOLD_MS); // 舊的總比沒有好
    throw e;
  }
  const body = encodeSnapshot(data, now);
  if (cache) {
    try { await cache.put(coloKey(key), new Response(body, { headers: { "Cache-Control": `max-age=${COLO_S}` } })); } catch (e) { /* 略過 */ }
  }
  if (info.missing || !env.RATE_KV) return keep(data, HOLD_MS);
  try {
    await env.RATE_KV.put(key, body);
    return keep(data, MEM_MS);
  } catch (e) {
    return keep(data, HOLD_MS);
  }
}

// worker 自己重建並寫回（問卷剛額滿、每日 Cron 的整份重建）。有表不存在被當成空的就不寫，回傳 null
export async function refreshSnapshot(env, name, q, now = Date.now()) {
  const info = {};
  const data = await buildSnapshot(name, q, info);
  if (info.missing) return null;
  const key = snapshotKey(name, envNameOf(env));
  mem.set(key, { until: now + MEM_MS, data });
  if (env.RATE_KV) await env.RATE_KV.put(key, encodeSnapshot(data, now));
  return data;
}

// 每日 Cron：重建這個環境的全部快照（後台或 CLI 漏寫、寫失敗、有人直接改資料庫時，最慢一天內自己修好）
// 每一份的結果："ok"、"ok_emptied:<原本筆數>"（原本有資料、重建後是空的：照寫，但要人看一下是不是真的都結束了）、
// "skipped_missing_table"、"error: …"
const countOf = (name, d) => (!d ? 0 : name === "announcements" || name === "lotteries" ? (d.v1 || []).length + (d.v2 || []).length
  : name === "features" ? Object.keys(d).length : d.length);
export async function refreshAllSnapshots(env, q, now = Date.now()) {
  const out = {};
  for (const name of SNAPSHOT_NAMES) {
    try {
      let before = 0;
      try { const old = env.RATE_KV && decodeSnapshot(await env.RATE_KV.get(snapshotKey(name, envNameOf(env)), { type: "text" }), name); before = old ? countOf(name, old.data) : 0; } catch (e) { /* 讀不到舊的就不比 */ }
      const data = await refreshSnapshot(env, name, q, now);
      out[name] = !data ? "skipped_missing_table" : before > 0 && countOf(name, data) === 0 ? `ok_emptied:${before}` : "ok";
    } catch (e) { out[name] = "error: " + String((e && e.message) || e).slice(0, 200); }
  }
  return out;
}
