// 抽獎、中獎人分正式／測試環境（後台 API 的 env 參數 → withDb），以及測試環境寄信一律改寄給自己。
// 資料庫用假的 Neon（攔 fetch，依連線字串的主機分正式／測試），Google 的 token 與 Gmail 也是假的
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://ep-prod.ap-southeast-1.aws.neon.tech/db";
process.env.DATABASE_URL_STAGING = "postgres://ep-staging.ap-southeast-1.aws.neon.tech/db";
process.env.GOOGLE_OAUTH = JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r", email: "me@example.com" });
const { handleAdminApi } = await import("../scripts/lib/admin-api.mjs");
const { makeSession } = await import("../scripts/lib/admin-auth.mjs");
const L = await import("../scripts/lib/lotteries.mjs");
const V = await import("../scripts/lib/lotteries-v2.mjs");
const I = await import("../scripts/lib/invites.mjs");

const KEY = "k".repeat(40);
const realFetch = globalThis.fetch;
let neon, mails, answer;
const lotteryRow = (id, mailedAt) => ({
  id, migrated_from: null, title: { "zh-TW": "抽獎" }, country: "SG", currency: "SGD", gift_cards: [{ name: "FairPrice", amount: 10 }], note: null,
  isps: null, winners: 1, draw_days: 7, starts_ms: 1, ends_ms: 2, start_date: "2026-11-01", end_date: "2026-11-15", status: "ended",
  draw: { at: 1, winners: [{ email: "real.person@example.com", rid: "R1", isp: "Singtel", receivedAt: 1, ...(mailedAt ? { mailedAt } : {}) }], pool: 1, entries: 1, excluded: {} },
});
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", expires_in: 3600 });
    if (url.includes("gmail/v1/users/me/messages/send")) {
      const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8");
      mails.push({ to: /^To: (.*)$/m.exec(raw)[1], subject: Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(raw)?.[1] || "", "base64").toString("utf8") || /^Subject: (.*)$/m.exec(raw)[1] });
      return Response.json({ id: "m", threadId: "t" });
    }
    if (init.headers && init.headers["Neon-Connection-String"]) {
      const { query, params } = JSON.parse(init.body);
      const host = new URL(init.headers["Neon-Connection-String"]).hostname;
      const q = query.replace(/\s+/g, " ").trim();
      neon.push({ host, query: q, params });
      const rows = answer(q, params, host) || [];
      return new Response(JSON.stringify({ rows, rowCount: rows.length }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
});
after(() => { globalThis.fetch = realFetch; delete process.env.GOOGLE_OAUTH; });
beforeEach(() => { neon = []; mails = []; answer = () => []; });

const ctx = { local: false, ip: "1", limiter: { get: async () => 0, incr: async () => {} },
              env: { ADMIN_USER: "u", ADMIN_PASS_HASH: "x", ADMIN_SESSION_KEY: KEY, GOOGLE_OAUTH: "{}", RATE_KV: { put: async () => {} } } };
async function api(name, args) {
  const res = await handleAdminApi(new Request(`https://biboost.app/admin/api/${name}`, {
    method: "POST", body: JSON.stringify({ args }),
    headers: { "Content-Type": "application/json", "X-BB-Admin": "1", Origin: "https://biboost.app", Cookie: `__Host-bb_admin=${await makeSession(KEY)}` },
  }), ctx);
  return res.json();
}
const hosts = (re) => [...new Set(neon.filter((x) => re.test(x.query)).map((x) => x.host.split(".")[0]))];

describe("後台 API：抽獎、中獎人照 env 切資料庫", () => {
  test("列表、單筆、存檔、提前結束都打選的環境；回傳帶 env（畫面用來認出舊版伺服器）", async () => {
    answer = (q) => (/from lotteries_v2 where id = \$1/.test(q) ? [lotteryRow(6)] : /^insert into lotteries_v2/.test(q) ? [{ id: 8 }] : /^update lotteries_v2 set title/.test(q) ? [{ id: 6 }] : []);
    const list = await api("listLotteriesV2", ["staging"]);
    assert.equal(list.result.env, "staging");
    assert.equal(list.result.envActions, true, "新版伺服器才有：抽獎頁看到它才讓人操作（舊版的動作會改到正式環境）");
    const one = await api("getLotteryV2", [6, "staging"]);
    assert.equal(one.result.env, "staging");
    assert.equal(one.result.lottery.id, 6);
    const meta = { title: { en: "T" }, country: "SG", start: "2026-11-01", end: "2026-11-15", currency: "SGD", giftCards: [{ name: "A", amount: 10 }], winners: "1", isps: [], drawDays: "7" };
    const added = await api("saveLotteryV2", [null, meta, "staging"]);
    assert.deepEqual(added.result, { id: 8, env: "staging" });
    await api("saveLotteryV2", [6, meta, "staging"]);
    await api("endLotteryV2", [6, "staging"]);
    assert.deepEqual(hosts(/lotteries_v2/), ["ep-staging"], "全部打測試環境");
    assert.ok(neon.some((x) => /^insert into lotteries_v2/.test(x.query)));
    assert.ok(neon.some((x) => /^with v as \(update lotteries_v2 set ended_at/.test(x.query)));
  });
  test("沒帶 env（舊版畫面）＝正式環境；認不得的環境直接拒絕", async () => {
    answer = (q) => (/from lotteries_v2 where id = \$1/.test(q) ? [lotteryRow(6)] : []);
    const one = await api("getLotteryV2", [6]);
    assert.equal(one.result.env, "prod");
    assert.deepEqual(hosts(/lotteries_v2/), ["ep-prod"]);
    neon = [];
    const bad = await api("saveLotteryV2", [null, {}, "dev"]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不認得的環境/);
    assert.equal(neon.filter((x) => /lotteries_v2/.test(x.query)).length, 0);
  });
  test("中獎人頁：列表、邀請碼、審核、禮物卡、刪除都打選的環境", async () => {
    answer = (q) => {
      if (/^insert into invite_codes/.test(q)) return [{ code: "ABCDEFGH" }];
      if (/select 1 from lotteries_v2 where id/.test(q)) return [{ "?column?": 1 }];
      if (/select \* from invite_codes where code/.test(q)) return [{ code: "ABCDEFGH", email: "x@example.com" }];
      if (/from lotteries_v2 where id = \$1/.test(q)) return [lotteryRow(6)];
      if (/select prize_sent_at from invite_codes/.test(q)) return [{ prize_sent_at: null }];
      return [];
    };
    // 試算表讀不到（假 fetch 沒有 drive）：listWinners 照樣回資料庫的部分
    const w = await api("listWinners", ["staging"]);
    assert.equal(w.result.env, "staging");
    await api("createInvite", ["x@example.com", 6, "staging"]);
    await api("setReview", ["ABCDEFGH", "valid", "", "staging"]);
    await api("revokeInvite", ["ABCDEFGH", "staging"]);
    await api("setPrize", ["lottery:6:R1", { date: "2026-11-20", cost: 10, currency: "SGD" }, {}, "staging"]);
    await api("deleteWinner", ["invite:ABCDEFGH", "staging"]);
    assert.deepEqual(hosts(/invite_codes|lotteries_v2/), ["ep-staging"]);
    assert.ok(neon.some((x) => /^insert into invite_codes/.test(x.query) && x.host.startsWith("ep-staging")));
    assert.ok(neon.some((x) => /create table if not exists invite_codes/.test(x.query) && x.host.startsWith("ep-staging")), "測試環境自己建表（不跟正式共用「已建表」的記號）");
  });
});

describe("測試環境寄信一律改寄給自己", () => {
  test("抽獎中獎人：測試環境改寄 me@，主旨加 [測試環境]，記成已寄信；草稿帶 redirectToSelf", async () => {
    let saved = null;
    answer = (q, p) => {
      if (/from lotteries_v2 where id = \$1/.test(q)) return [lotteryRow(6)];
      if (/^update lotteries_v2 set draw/.test(q)) { saved = JSON.parse(p[1]); return [{ id: 6 }]; }
      return [];
    };
    const draft = await L.withDb("staging", () => V.winnerMailDraft(6, "R1"));
    assert.equal(draft.redirectToSelf, true);
    assert.equal(draft.to, "real.person@example.com", "草稿照樣顯示中獎人是誰");
    await L.withDb("staging", () => V.sendWinnerMail(6, "R1", { subject: "恭喜中獎", body: "內文" }));
    assert.deepEqual(mails, [{ to: "me@example.com", subject: "[測試環境] 恭喜中獎" }]);
    assert.ok(saved.winners[0].mailedAt > 0, "測試環境的資料記成已寄信");
    // 勾了「寄給我自己」：照舊只是測試信，不記
    mails = []; saved = null;
    await L.withDb("staging", () => V.sendWinnerMail(6, "R1", { subject: "s", body: "b", toSelf: true }));
    assert.deepEqual(mails, [{ to: "me@example.com", subject: "[測試] [測試環境] s" }]);
    assert.equal(saved, null);
  });
  test("正式環境照舊寄給中獎人（草稿 redirectToSelf: false）", async () => {
    answer = (q) => (/from lotteries_v2 where id = \$1/.test(q) ? [lotteryRow(6)] : /^update lotteries_v2 set draw/.test(q) ? [{ id: 6 }] : []);
    const draft = await L.withDb("prod", () => V.winnerMailDraft(6, "R1"));
    assert.equal(draft.redirectToSelf, false);
    await L.withDb("prod", () => V.sendWinnerMail(6, "R1", { subject: "恭喜中獎", body: "內文" }));
    assert.deepEqual(mails, [{ to: "real.person@example.com", subject: "恭喜中獎" }]);
  });
  test("必中獎參加人：測試環境一樣改寄給自己", async () => {
    answer = (q) => (/select \* from invite_codes where code/.test(q) ? [{ code: "ABCDEFGH", email: "real.person@example.com" }] : []);
    await L.withDb("staging", () => I.sendInviteMail("ABCDEFGH", { subject: "謝謝", body: "內文" }));
    assert.deepEqual(mails, [{ to: "me@example.com", subject: "[測試環境] 謝謝" }]);
    assert.ok(neon.some((x) => /^update invite_codes set mailed_at/.test(x.query) && x.host.startsWith("ep-staging")));
  });
  test("經過後台 API 也一樣（sendWinnerMailV2 帶 staging）", async () => {
    answer = (q) => (/from lotteries_v2 where id = \$1/.test(q) ? [lotteryRow(6)] : /^update lotteries_v2 set draw/.test(q) ? [{ id: 6 }] : []);
    const r = await api("sendWinnerMailV2", [6, "R1", { subject: "恭喜", body: "b" }, "staging"]);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(mails, [{ to: "me@example.com", subject: "[測試環境] 恭喜" }]);
  });
});
