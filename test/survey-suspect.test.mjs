// 可疑作答（scripts/lib/surveys.mjs 的 suspectReasons、dupReference）與 report worker 存 IP 雜湊（tools/report-worker/src/surveys.js 的 ipHash、saveResponse）
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { suspectReasons, dupReference, SUSPECT } from "../scripts/lib/surveys.mjs";
import { ipHash, surveyStore, handleSurveys } from "../tools/report-worker/src/surveys.js";
import { sampleDef } from "./helpers/survey-sample.mjs";

const H = 3600000, T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
let n = 0;
// 一份正常的完成作答：有出現紀錄、花了 60 秒
function row(over = {}) {
  n++;
  const startedAt = over.startedAt ?? T0 + n * 1000;
  const completedAt = over.completedAt === undefined ? startedAt + 60000 : over.completedAt;
  return { responseId: "r" + n, completed: true, startedAt, completedAt, updatedAt: completedAt ?? startedAt, browser: "chrome", country: "TW",
    answers: { q1: "a" }, shownAt: startedAt - 5000, ipHash: null, ...over };
}
const reasons = (rows) => Object.fromEntries([...suspectReasons(rows)].map(([k, v]) => [k, v]));

describe("可疑作答：沒有出現紀錄", () => {
  test("找不到 shown 事件 → no_shown；有 shown 的不標", () => {
    const a = row({ shownAt: null }), b = row();
    assert.deepEqual(reasons([a, b]), { [a.responseId]: ["no_shown"] });
  });
  test("shown 比完成晚 1 分鐘以上（時間對不上）→ no_shown；晚一點點（事件送達比作答慢）不標", () => {
    const late = row(), ok = row();
    late.shownAt = late.completedAt + SUSPECT.SHOWN_SLACK_MS + 1;
    ok.shownAt = ok.completedAt + 5000;
    assert.deepEqual(reasons([late, ok]), { [late.responseId]: ["no_shown"] });
  });
  test("填到一半的沒有 shown 也標；Firefox 不套這條（沒同意匿名統計時擴充不送事件）", () => {
    const half = row({ completed: false, completedAt: null, shownAt: null }), fx = row({ browser: "firefox", shownAt: null });
    assert.deepEqual(reasons([half, fx]), { [half.responseId]: ["no_shown"] });
  });
});

describe("可疑作答：同 IP 同答案", () => {
  test("同一個 IP 雜湊、答案完全一樣、相隔不到 1 小時 ≥ 2 份 → 留最早那份，其他標 same_ip", () => {
    const a = row({ ipHash: "h1", updatedAt: T0 }), b = row({ ipHash: "h1", updatedAt: T0 + 10 * 60000 }), c = row({ ipHash: "h1", updatedAt: T0 + 50 * 60000 });
    assert.deepEqual(reasons([c, a, b]), { [b.responseId]: ["same_ip"], [c.responseId]: ["same_ip"] });
  });
  test("同 IP 但答案不同：不標（宿舍、公司、電信商共用 IP 的正常使用者）", () => {
    const a = row({ ipHash: "h1", answers: { q1: "a" } }), b = row({ ipHash: "h1", answers: { q1: "b" } });
    assert.deepEqual(reasons([a, b]), {});
  });
  test("同 IP 同答案但相隔超過 1 小時：不標；一串一串分開算", () => {
    const a = row({ ipHash: "h1", updatedAt: T0 }), b = row({ ipHash: "h1", updatedAt: T0 + H + 1 });
    assert.deepEqual(reasons([a, b]), {});
    const c = row({ ipHash: "h2", updatedAt: T0 }), d = row({ ipHash: "h2", updatedAt: T0 + 2 * H }), e = row({ ipHash: "h2", updatedAt: T0 + 2 * H + 60000 });
    assert.deepEqual(reasons([c, d, e]), { [e.responseId]: ["same_ip"] });
  });
  test("不同 IP 同答案：不標；沒有 ip_hash（沒設 secret）的不判斷；填到一半的不算", () => {
    const a = row({ ipHash: "h1" }), b = row({ ipHash: "h2" }), c = row(), d = row();
    const e = row({ ipHash: "h3" }), f = row({ ipHash: "h3", completed: false, completedAt: null });
    assert.deepEqual(reasons([a, b, c, d, e, f]), {});
  });
});

describe("可疑作答：太快、舊規則", () => {
  test("開始到完成 < 8 秒 → fast；好幾個原因時照固定順序", () => {
    const fast = row({ completedAt: T0 + 3000, startedAt: T0, shownAt: null });
    assert.deepEqual(reasons([fast]), { [fast.responseId]: ["no_shown", "fast"] });
  });
  test("同一小時、同一國家、答案完全一樣 5 份以上：不再標記，只算進參考數字", () => {
    const rows = Array.from({ length: 6 }, () => row({ startedAt: T0 + 1000 }));
    assert.deepEqual(reasons(rows), {});
    assert.equal(dupReference(rows), 6);
    assert.equal(dupReference(rows.slice(0, 4)), 0);
  });
});

describe("report worker：IP 雜湊", () => {
  test("沒設 IP_HASH_SECRET 或沒有 IP：null；有設：HMAC 前 16 bytes（32 個 hex），同 IP 一樣、不同 IP 不同、換 secret 也不同", async () => {
    assert.equal(await ipHash({}, "1.2.3.4"), null);
    assert.equal(await ipHash({ IP_HASH_SECRET: "s" }, null), null);
    const a = await ipHash({ IP_HASH_SECRET: "s" }, "1.2.3.4");
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(await ipHash({ IP_HASH_SECRET: "s" }, "1.2.3.4"), a);
    assert.notEqual(await ipHash({ IP_HASH_SECRET: "s" }, "1.2.3.5"), a);
    assert.notEqual(await ipHash({ IP_HASH_SECRET: "t" }, "1.2.3.4"), a);
    assert.ok(!a.includes("1.2.3.4"));
  });
  const base = { response_id: "0".repeat(32), survey_id: "sample-survey", answers: {}, email: null, country: "US", entry: "invite", browser: "chrome", ext_version: "2.11.0",
    lang: "en", install_days: "7_30", custom_nodes: false, completed: 1, after_end: 0, at: 1 };
  test("saveResponse：沒有 ip_hash 時 SQL 不碰這個欄位；有的時候寫進去（已完成的那筆收到草稿時保留原值）", async () => {
    const seen = [];
    const s = surveyStore({}, async (env, sql, params) => { seen.push({ sql, params }); return []; });
    await s.saveResponse({ ...base, ip_hash: null });
    assert.doesNotMatch(seen[0].sql, /ip_hash/);
    assert.equal(seen[0].params.length, 15);
    await s.saveResponse({ ...base, ip_hash: "ab".repeat(16) });
    assert.match(seen[1].sql, /updated_at, ip_hash\)/);
    assert.match(seen[1].sql.replace(/\s+/g, " "), /ip_hash = case when survey_responses.completed = 1 and excluded.completed = 0 then survey_responses.ip_hash else excluded.ip_hash end/);
    assert.equal(seen[1].params[15], "ab".repeat(16));
  });
  test("saveResponse：資料庫還沒加 ip_hash 欄位時退回不存，作答照收；其他錯誤照樣丟出", async () => {
    const seen = [];
    const s = surveyStore({}, async (env, sql) => {
      seen.push(sql);
      if (/ip_hash/.test(sql)) throw new Error('column "ip_hash" of relation "survey_responses" does not exist');
      return [];
    });
    await s.saveResponse({ ...base, ip_hash: "ab".repeat(16) });
    assert.equal(seen.length, 2);
    assert.doesNotMatch(seen[1], /ip_hash/);
    const broken = surveyStore({}, async () => { throw new Error("connection refused"); });
    await assert.rejects(broken.saveResponse({ ...base, ip_hash: "ab".repeat(16) }), /connection refused/);
  });
  test("收作答：有 secret 時把 CF-Connecting-IP 的雜湊交給 saveResponse，不交 IP 原值；沒 secret 時是 null", async () => {
    for (const secret of ["s", undefined]) {
      const saved = [];
      const store = {
        publishedSurvey: async () => ({ def: sampleDef(), ended: false }), response: async () => null,
        saveResponse: async (r) => { saved.push(r); }, countCompleted: async () => ({ justEnded: false }),
      };
      const req = new Request("https://api.biboost.app/v2/surveys/responses", {
        method: "POST", headers: { Origin: "chrome-extension://dfaddcffoondcendifiljhdbdagebgch", "CF-Connecting-IP": "9.9.9.9", "CF-IPCountry": "US" },
        body: JSON.stringify({ survey_id: "sample-survey", response_id: "1".repeat(32), answers: { q_fruit: ["apple"], q_often: "never", q_rate: 5 }, final: true, entry: "invite",
          client: { browser: "chrome", ext_version: "2.11.0", lang: "en", install_days: "7_30", custom_nodes: false } }),
      });
      const json = (status, obj) => new Response(JSON.stringify(obj), { status });
      const r = await handleSurveys(req, secret ? { IP_HASH_SECRET: secret } : {}, { waitUntil() {} }, new URL(req.url),
        { json, fail: (st, e) => json(st, { error: e }), CORS: {}, storeIds: { dfaddcffoondcendifiljhdbdagebgch: "chrome" }, store, now: () => T0 });
      assert.equal(r.status, 200);
      assert.equal(saved[0].ip_hash, secret ? await ipHash({ IP_HASH_SECRET: secret }, "9.9.9.9") : null);
      assert.ok(!JSON.stringify(saved[0]).includes("9.9.9.9"), "不交 IP 原值");
    }
  });
});
