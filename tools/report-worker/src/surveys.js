/**
 * 問卷與匿名統計（擴充呼叫）。題目、選項、跳題都存在 Neon 的 surveys（admin 管理，見 scripts/lib/surveys.mjs），
 * 但所有安裝都會打的請求不碰 Neon：問卷清單讀 KV 快照（snapshots.js，後台發布、停止時寫），
 * 心跳、地區限定、觸發機會寫 Analytics Engine（telemetry.js，每天 Cron 彙總回 Neon）。作答與事件只有看到問卷的人送，直接寫 Neon。
 * 規則用擴充的 src/survey-core.js（擴充、這裡、admin 共用同一份）：跳題是流程圖，收作答時照答案走出路徑，只存路徑上的答案。國家一律用 CF-IPCountry（缺或不是兩碼大寫 = XX），不存 IP。
 * 作答另外存 ip_hash（有設 Worker secret IP_HASH_SECRET 才存）：IP 的 HMAC 雜湊（還原不回 IP），後台只用來標記「同 IP、同一小時、答案完全一樣」的重複作答（不另外清除）。
 *
 *   GET  /v2/surveys?lang=<介面語言>&v=<擴充版本>   進行中的問卷清單（依國家、語言、期間、額滿、擴充版本過濾；變體依國家套好）
 *                                                  → { surveys: [...] }；CN 回空清單。讀 KV 快照，期間在這裡用現在時間判斷
 *   POST /v2/surveys/responses                     作答：{ survey_id, response_id, answers, final, entry, client }，每答一題送一次、以 response_id 覆蓋（已經完成的那筆只有 final 才覆蓋：公告重填）
 *                                                  → { ok }；問卷結束（到期、額滿、停止）照收並標 after_end；沒發布過的問卷 404；版本不符沒有（發布後不能改）
 *                                                  送出完成剛好額滿時，重建 KV 的問卷快照，把它從清單拿掉
 *   POST /v2/surveys/events                        { survey_id, response_id, kind: shown|page|closed|completed, page?, question?, ms?, entry, client } → 204
 *   POST /v2/surveys/triggers                      { trigger: invite|<事件>, result } 觸發機會 → 204；Analytics Engine，彙總到 survey_trigger_daily
 *   POST /v1/telemetry/heartbeat                   抽樣播放心跳 → 204；Analytics Engine，彙總到 telemetry_heartbeat（每 5 分鐘 × 國家一格）
 *   POST /v1/telemetry/blocked                     遇到地區限定 → 204；Analytics Engine，彙總到 telemetry_blocked（每日 × 國家一格）
 *
 * 防濫用：寫入只收擴充的 Origin（正式環境：商店版的 Chrome／Edge id，Firefox、Safari 每台安裝的 id 不同只看開頭；
 * 測試環境 SURVEY_ANY_EXTENSION = "1" 時收所有擴充，開發版的 id 不固定），並用 Rate Limiting binding 依 IP 限流（計數在記憶體、不存 IP）。
 * 這擋得住別的網站在瀏覽器裡呼叫，擋不住自己帶 Origin 標頭的腳本；做不到「證明真的有安裝擴充」。
 */
import "../../../src/survey-core.js";
import { buildSnapshot, liveSurveys, readSnapshot, refreshSnapshot } from "./snapshots.js";
import { writePoint } from "./telemetry.js";

const Core = globalThis.BBSurveyCore;
const BODY_MAX = 8 * 1024;
const EVENT_KINDS = ["shown", "page", "closed", "completed"];
export const TRIGGER_RESULTS = ["shown", "cooldown", "today", "new_install", "welcome", "none"];
const RID_RE = /^[0-9a-f]{32}$/;
const SID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/([A-Za-z0-9._-]+)$/;

export function countryOf(request) {
  const c = (request.cf && request.cf.country) || request.headers.get("CF-IPCountry") || "";
  return /^[A-Z]{2}$/.test(c) ? c : "XX";
}

// 寫入只收擴充的 Origin（瀏覽器自動帶、網頁偽造不了）
export function extOriginOk(request, env, storeIds) {
  const m = EXT_ORIGIN.exec(request.headers.get("Origin") || "");
  if (!m) return false;
  if (env.SURVEY_ANY_EXTENSION === "1") return true;
  if (m[1] === "chrome-extension") return !!storeIds[m[2]];
  return true;
}

// IP 的雜湊：HMAC-SHA256(IP_HASH_SECRET, IP) 取前 16 bytes（hex）。不存 IP 原值；沒設 secret、沒有 IP 或算不出來時回 null（不存、那條可疑規則跳過）
export async function ipHash(env, ip) {
  const secret = env && env.IP_HASH_SECRET;
  if (!secret || !ip) return null;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(String(ip))));
    return Array.from(sig.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  } catch (e) { return null; }
}

async function limited(binding, key) {
  if (!binding || typeof binding.limit !== "function") return false;
  try { return !(await binding.limit({ key })).success; } catch (e) { return false; } // 限流服務出錯時不擋人
}

async function readJson(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_MAX) throw new Core.SurveyError(413, "too_large");
  try {
    const b = JSON.parse(raw);
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch (e) { /* 下面一起回 bad_json */ }
  throw new Core.SurveyError(400, "bad_json");
}

// 資料操作集中在這裡（測試換成記憶體版本）。時間一律毫秒
export function surveyStore(env, neonSql) {
  const q = (sql, params) => neonSql(env, sql, params);
  return {
    // 進行中的問卷：KV 快照（含還沒開始的，連同 startsAt／endsAt；handleSurveys 依現在時間篩）。KV 沒有才查 Neon 一次
    activeSurveys() { return readSnapshot(env, "surveys", (info) => buildSnapshot("surveys", q, info)); },
    refreshSurveys() { return refreshSnapshot(env, "surveys", q); },
    // 收作答用：只要發布過就照收（結束了也收），回傳 { def, ended }
    async publishedSurvey(id) {
      const rows = await q(`select def, (ended_at is not null or (ends_at is not null and ends_at <= now())
          or (max_responses is not null and completed_count >= max_responses)) as ended
        from surveys where id = $1 and status = 'published'`, [id]);
      return rows[0] ? { def: rows[0].def, ended: !!rows[0].ended } : null;
    },
    async response(rid) {
      const rows = await q("select survey_id, completed from survey_responses where response_id = $1", [rid]);
      return rows[0] || null;
    },
    // 已經完成的那筆（completed = 1）：只有再送一次完成（公告重填）才覆蓋答案、Email 與 updated_at，草稿（每答一題送一次）不動它，
    // 免得重填到一半關掉時把原本完整的答案蓋成一半。所以完成過的那筆 updated_at > completed_at＝最後一次重填的時間；completed_at 留第一次完成
    // ip_hash（有設 IP_HASH_SECRET 才有）：IP 的 HMAC 雜湊，只用來找「同 IP、同一小時、答案完全一樣」的重複作答（不另外清除，只在分析時用）。
    // 沒有 ip_hash 時 SQL 跟加這個欄位之前一模一樣；有 ip_hash 但資料庫還沒加欄位（schema 沒跑）時，退回不存 ip_hash，作答照收
    async saveResponse(r) {
      const withIp = typeof r.ip_hash === "string" && r.ip_hash.length > 0;
      const run = (ip) => q(`insert into survey_responses (response_id, survey_id, version, answers, email, country, entry, browser, ext_version, lang,
          install_days, custom_nodes, completed, after_end, started_at, completed_at, created_at, updated_at${ip ? ", ip_hash" : ""})
        values ($1, $2, 1, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, $14${ip ? ", $16" : ""})
        on conflict (response_id) do update set
          answers = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.answers else excluded.answers end,
          email = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.email else excluded.email end,
          updated_at = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.updated_at else excluded.updated_at end,
          completed = greatest(survey_responses.completed, excluded.completed),
          completed_at = coalesce(survey_responses.completed_at, excluded.completed_at),
          after_end = greatest(survey_responses.after_end, excluded.after_end)${ip ? ",\n          ip_hash = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.ip_hash else excluded.ip_hash end" : ""}`,
        [r.response_id, r.survey_id, JSON.stringify(r.answers), r.email, r.country, r.entry, r.browser, r.ext_version, r.lang,
          r.install_days, r.custom_nodes, r.completed, r.after_end, r.at, r.completed ? r.at : null].concat(ip ? [r.ip_hash] : []));
      if (!withIp) return run(false);
      try { return await run(true); }
      catch (e) {
        if (!/column \\?"?ip_hash\\?"?.* does not exist/.test(String((e && e.message) || e))) throw e;
        console.error("survey ip_hash column missing; saved without it"); // wrangler tail 看得到：要跑 schema（scripts/lib/surveys.mjs 的 ensureSurveyTables）
        return run(false);
      }
    },
    // 送出完成：份數加一，到上限就結束（額滿）。回傳 { justEnded }：是不是這一份讓它從「進行中」變成「結束」
    // （prev 讀的是更新前的值；額滿之後再送來的完成不會再觸發重建快照）
    async countCompleted(id) {
      const rows = await q(`with prev as (select ended_at from surveys where id = $1)
        update surveys set completed_count = completed_count + 1,
          ended_reason = case when ended_at is null and max_responses is not null and completed_count + 1 >= max_responses then 'full' else ended_reason end,
          ended_at = case when ended_at is null and max_responses is not null and completed_count + 1 >= max_responses then now() else ended_at end,
          updated_at = now()
        where id = $1 returning (surveys.ended_at is not null and (select ended_at from prev) is null) as just_ended`, [id]);
      return { justEnded: !!(rows[0] && rows[0].just_ended) };
    },
    async addEvent(e) {
      await q(`insert into survey_events (response_id, survey_id, kind, page, question, ms, entry, country, lang, browser, ext_version, at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [e.response_id, e.survey_id, e.kind, e.page, e.question, e.ms, e.entry, e.country, e.lang, e.browser, e.ext_version, e.at]);
    },
    bumpTrigger(country, trigger, result) { writePoint(env, "trigger", country, trigger, result); },
    heartbeat(country) { writePoint(env, "heartbeat", country); },
    blocked(country) { writePoint(env, "blocked", country); },
  };
}

// 流程圖壞掉的問卷（出口指回前面、指到不存在的題目、有走不到的卡片、還是舊的 showIf 跳題）不下發、不收作答。
// 後台存檔與發布都會擋，這裡是最後一道：直接改資料庫或舊資料沒轉換時，擴充不會拿到走不完或意思不對的問卷
function flowBroken(id, def) {
  const errs = Core.checkFlow(def);
  if (errs.length) console.error("survey flow", id, errs.slice(0, 3).map((e) => e.path).join(",")); // wrangler tail 看得到
  return errs.length > 0;
}

// 進行中、給這個國家與語言、這個擴充版本畫得出來的問卷（變體依國家套好）
export function listFor(rows, country, lang, extVersion) {
  return rows
    .filter((r) => r.def && Core.audienceMatch(r.def, country, lang) && !flowBroken(r.id, r.def))
    .map((r) => Core.resolve({ ...r.def, id: r.id }, country))
    .filter((d) => Core.cmpVersion(extVersion, d.minExtVersion) >= 0);
}

const PATHS = ["/v2/surveys", "/v2/surveys/responses", "/v2/surveys/events", "/v2/surveys/triggers", "/v1/telemetry/heartbeat", "/v1/telemetry/blocked"];
export function isSurveyPath(pathname) { return PATHS.includes(pathname); }

// h：{ json, fail, CORS, storeIds, store?, now? }（store、now 給測試換掉）
export async function handleSurveys(request, env, ctx, url, h) {
  const store = h.store || surveyStore(env, h.neonSql);
  const now = h.now ? h.now() : Date.now();
  const country = countryOf(request);
  const noContent = () => new Response(null, { status: 204, headers: h.CORS });
  try {
    if (request.method === "GET" && url.pathname === "/v2/surveys") {
      const lang = Core.LANGS.includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : "en";
      const v = /^\d+(\.\d+){0,3}$/.test(url.searchParams.get("v") || "") ? url.searchParams.get("v") : "0";
      if (country === "CN") return h.json(200, { surveys: [] });
      const body = JSON.stringify({ surveys: listFor(liveSurveys(await store.activeSurveys(), now), country, lang, v) });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...h.CORS } });
    }
    if (request.method !== "POST") return h.fail(405, "method_not_allowed");
    if (!extOriginOk(request, env, h.storeIds || {})) return h.fail(403, "forbidden");
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    if (await limited(env.SURVEY_RL, ip)) return h.fail(429, "rate_limited");

    if (url.pathname === "/v1/telemetry/heartbeat") {
      await store.heartbeat(country);
      return noContent();
    }
    if (url.pathname === "/v1/telemetry/blocked") {
      await store.blocked(country);
      return noContent();
    }
    if (country === "CN") return h.fail(404, "not_found");
    const b = await readJson(request);

    if (url.pathname === "/v2/surveys/triggers") {
      if (!["invite"].concat(Core.EVENTS).includes(b.trigger) || !TRIGGER_RESULTS.includes(b.result)) return h.fail(400, "bad_trigger");
      await store.bumpTrigger(country, b.trigger, b.result);
      return noContent();
    }

    if (typeof b.survey_id !== "string" || !SID_RE.test(b.survey_id)) return h.fail(400, "bad_survey");
    if (typeof b.response_id !== "string" || !RID_RE.test(b.response_id)) return h.fail(400, "bad_response_id");
    const survey = await store.publishedSurvey(b.survey_id);
    if (!survey) return h.fail(404, "not_found");
    const c = Core.cleanClient(b.entry, b.client);

    if (url.pathname === "/v2/surveys/events") {
      if (!EVENT_KINDS.includes(b.kind)) return h.fail(400, "bad_event");
      const int = (x, max) => (Number.isInteger(x) && x >= 0 && x <= max ? x : null);
      const question = typeof b.question === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(b.question) ? b.question : null;
      await store.addEvent({ response_id: b.response_id, survey_id: b.survey_id, kind: b.kind, page: int(b.page, 100), question,
        ms: int(b.ms, 3_600_000), entry: c.entry, country, lang: c.lang, browser: c.browser, ext_version: c.ext_version, at: now });
      return noContent();
    }

    if (url.pathname === "/v2/surveys/responses") {
      const final = b.final === true;
      if (final && await limited(env.SURVEY_DONE_RL, ip)) return h.fail(429, "rate_limited");
      if (flowBroken(b.survey_id, survey.def)) return h.fail(409, "bad_definition");
      const def = Core.resolve({ ...survey.def, id: b.survey_id }, country);
      // 只留路徑上的答案（換了一條路之後舊路上的答案丟掉，見 survey-core 的 cleanAnswers）
      const cleaned = Core.cleanAnswers(def, b.answers, final);
      const prev = await store.response(b.response_id);
      if (prev && prev.survey_id !== b.survey_id) return h.fail(409, "conflict");
      // 已經完成的那筆收到草稿（公告重填答到一半）：不寫，保留上次送出的完整答案；重填送出（final）才覆蓋。saveResponse 的 SQL 也有同一條保護
      if (prev && prev.completed && !final) return h.json(200, { ok: true });
      await store.saveResponse({ response_id: b.response_id, survey_id: b.survey_id, answers: cleaned.answers, email: cleaned.email, country,
        entry: c.entry, browser: c.browser, ext_version: c.ext_version, lang: c.lang, install_days: c.install_days, custom_nodes: c.custom_nodes,
        completed: final ? 1 : 0, after_end: survey.ended ? 1 : 0, at: now, ip_hash: await ipHash(env, request.headers.get("CF-Connecting-IP")) });
      if (final && !(prev && prev.completed)) {
        const r = await store.countCompleted(b.survey_id);
        // 剛好額滿：把它從 KV 的清單拿掉（失敗不影響這份作答；每日 Cron 會整份重建當保底）
        if (r && r.justEnded && store.refreshSurveys) ctx.waitUntil(Promise.resolve().then(() => store.refreshSurveys()).catch((e) => console.error("survey snapshot", String((e && e.message) || e))));
      }
      return h.json(200, { ok: true });
    }
    return h.fail(404, "not_found");
  } catch (e) {
    if (e instanceof Core.SurveyError) return h.fail(e.status, e.code);
    console.error("survey", url.pathname, String((e && e.message) || e)); // wrangler tail 看得到；不含使用者資料
    return h.fail(500, "server_error");
  }
}
