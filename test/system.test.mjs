// 後台「系統狀態」頁的資料（scripts/lib/system.mjs）：每日工作的健康判斷、執行紀錄、匿名統計（心跳 → 同時觀看人數、地區限定）。
// 只讀：表不存在就回空的，不建表（正式環境可能還沒部署過）。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dailyHealth, dailyProblems, dailyRunStatus, runState, slotsOf, summarizeBuckets, recentFromAe, telemetryStats,
  STALE_MS, RUNNING_MAX_MS, FIRST_RUN_MS, TELEMETRY_DATASETS,
} from "../scripts/lib/system.mjs";

const NOW = Date.UTC(2026, 10, 18, 3, 0, 0); // 2026-11-18 03:00 UTC
const H = 3_600_000;
const okRun = (ranAt, extra = {}) => ({ ranAt, ok: true, detail: { rollup: { configured: true, days: [] }, snapshots: {}, warnings: [], ...extra } });

// 假的 Neon：記下每一句 SQL；tables 是存在的表
function fakeDb(tables, answer = () => []) {
  const log = [];
  const q = async (query, params = []) => {
    log.push(query);
    const m = /to_regclass\('public\.(\w+)'\)/.exec(query);
    if (m) return [{ t: tables.includes(m[1]) ? m[1] : null }];
    return answer(query, params);
  };
  return { q, log };
}
const noDdl = (log) => assert.ok(log.every((s) => !/\b(create|alter|insert|update|delete|drop)\b/i.test(s)), log.join("\n"));

describe("每日工作的健康判斷（dailyHealth）", () => {
  test("沒有紀錄：還沒部署過＝info；部署後超過 26 小時還沒有紀錄＝error；測試環境不判", () => {
    assert.equal(dailyHealth({ never: true }, NOW).level, "info");
    assert.equal(dailyHealth({ never: true, deployedAt: NOW - FIRST_RUN_MS + H }, NOW).level, "info", "剛部署");
    const late = dailyHealth({ never: true, deployedAt: NOW - FIRST_RUN_MS - H }, NOW);
    assert.equal(late.level, "error");
    assert.match(late.title, /從來沒跑過/);
    assert.equal(dailyHealth({ never: true, deployedAt: NOW - 5 * 86_400_000 }, NOW, { scheduled: false }).level, "info");
  });

  test("正常＝ok；有警告＝warning；超過 2 天沒成功＝error", () => {
    const last = okRun(NOW - H);
    assert.equal(dailyHealth({ last, lastOk: last }, NOW).level, "ok");
    const warn = okRun(NOW - H, { warnings: ["2026-11-17 沒有任何播放心跳"] });
    const w = dailyHealth({ last: warn, lastOk: warn }, NOW);
    assert.equal(w.level, "warning");
    assert.deepEqual(w.lines, ["2026-11-17 沒有任何播放心跳"]);
    const old = okRun(NOW - STALE_MS - H);
    const s = dailyHealth({ last: old, lastOk: old }, NOW);
    assert.equal(s.level, "error");
    assert.match(s.lines[0], /超過 2 天/);
    assert.equal(dailyHealth({ last: old, lastOk: old }, NOW, { scheduled: false }).level, "ok", "測試環境不排程：舊的不算問題");
  });

  test("最近一次失敗＝error（就算前一天成功），列出每個失敗的地方與警告", () => {
    const lastOk = okRun(NOW - 25 * H);
    const last = { ranAt: NOW - H, ok: false, detail: {
      rollup: { configured: true, days: [{ day: "2026-11-16", heartbeat: 3 }, { day: "2026-11-17", error: "analytics_engine_500" }] },
      snapshots: { announcements: "ok", surveys: "skipped_missing_table", features: "neon_500 boom", lotteries: "ok_emptied:2" },
      warnings: ["快照 lotteries 原本有 2 筆"], recordError: "x",
    } };
    const h = dailyHealth({ last, lastOk }, NOW);
    assert.equal(h.level, "error");
    assert.ok(h.lines.includes("2026-11-17 彙總失敗：analytics_engine_500"));
    assert.ok(h.lines.includes("快照 features：neon_500 boom"));
    assert.ok(h.lines.includes("記錄失敗：x"));
    assert.ok(h.lines.includes("快照 lotteries 原本有 2 筆"));
    assert.ok(!h.lines.some((l) => /announcements|surveys：/.test(l)), "成功與表不存在的不列");
    assert.equal(dailyHealth({ last, lastOk }, NOW, { scheduled: false }).level, "error", "測試環境手動跑失敗也標出來");
  });

  test("失敗原因只寫在警告裡（統計沒設定 secret）也是 error；什麼都沒寫也不會變成正常", () => {
    const last = { ranAt: NOW - H, ok: false, detail: { rollup: { configured: false, missing: ["CF_ACCOUNT_ID"], days: [] }, snapshots: {}, warnings: ["匿名統計的每日彙總沒有設定：CF_ACCOUNT_ID"] } };
    const h = dailyHealth({ last, lastOk: okRun(NOW - 20 * H) }, NOW);
    assert.equal(h.level, "error");
    assert.ok(h.lines.includes("匿名統計的每日彙總沒有設定：CF_ACCOUNT_ID"));
    const bare = dailyHealth({ last: { ranAt: NOW - H, ok: false, detail: {} }, lastOk: okRun(NOW - 20 * H) }, NOW);
    assert.equal(bare.level, "error");
    assert.match(bare.lines[0], /沒有寫原因/);
  });

  test("開始了還沒寫完：1 小時內是執行中（不紅），超過 1 小時＝中途被終止（紅）", () => {
    const lastOk = okRun(NOW - 25 * H);
    const running = { ranAt: NOW - 10 * 60_000, ok: false, detail: { running: true } };
    assert.equal(runState(running, NOW), "running");
    assert.equal(dailyHealth({ last: running, lastOk }, NOW).level, "ok");
    const cut = { ...running, ranAt: NOW - RUNNING_MAX_MS - 60_000 };
    assert.equal(runState(cut, NOW), "cut");
    const h = dailyHealth({ last: cut, lastOk }, NOW);
    assert.equal(h.level, "error");
    assert.match(h.lines[0], /沒跑完/);
  });

  test("dailyProblems：快照整個失敗只列一條", () => {
    assert.deepEqual(dailyProblems({ snapshots: { error: "kv down" } }), ["快照重建失敗：kv down"]);
    assert.deepEqual(dailyProblems(null), []);
  });
});

describe("每日工作的執行紀錄（dailyRunStatus）", () => {
  test("沒有 cron_runs 表：回 never，只問 to_regclass、不建表", async () => {
    const { q, log } = fakeDb([]);
    const s = await dailyRunStatus({ q, now: NOW, scheduled: true });
    assert.equal(s.never, true);
    assert.deepEqual(s.runs, []);
    assert.equal(s.health.level, "info");
    assert.equal(log.length, 1);
    noDdl(log);
  });

  test("有紀錄：最近幾次、最後成功、部署時間、健康判斷", async () => {
    const rows = [
      { id: "3", ran_at: new Date(NOW - H).toISOString(), ok: false, detail: { snapshots: { error: "boom" } } },
      { id: "2", ran_at: new Date(NOW - 25 * H).toISOString(), ok: true, detail: { warnings: [] } },
    ];
    const { q, log } = fakeDb(["cron_runs"], (query) => {
      if (/name = 'deployed'/.test(query)) return [{ ran_at: new Date(NOW - 50 * H).toISOString() }];
      if (/and ok/.test(query)) return [rows[1]];
      if (/name = 'daily'/.test(query)) return rows;
      return [];
    });
    const s = await dailyRunStatus({ q, now: NOW, scheduled: true });
    assert.equal(s.never, false);
    assert.deepEqual(s.runs.map((r) => [r.id, r.state]), [[3, "failed"], [2, "ok"]]);
    assert.equal(s.last.id, 3);
    assert.equal(s.lastOk.ranAt, NOW - 25 * H);
    assert.equal(s.deployedAt, NOW - 50 * H);
    assert.equal(s.health.level, "error");
    assert.ok(s.health.lines.includes("快照重建失敗：boom"));
    noDdl(log);
  });

  test("表在但一筆 daily 都沒有（只有 deployed）：never，部署超過 26 小時＝error", async () => {
    const { q } = fakeDb(["cron_runs"], (query) => (/name = 'deployed'/.test(query) ? [{ ran_at: new Date(NOW - 30 * H).toISOString() }] : []));
    const s = await dailyRunStatus({ q, now: NOW, scheduled: true });
    assert.equal(s.never, true);
    assert.equal(s.health.level, "error");
  });
});

describe("匿名統計（telemetryStats）", () => {
  const B = (day, hh, mm = 0) => Date.parse(`${day}T00:00:00Z`) + hh * H + mm * 60_000;

  test("slotsOf：過去的日子 288 格，今天算到現在，未來 0", () => {
    assert.equal(slotsOf("2026-11-17", NOW), 288);
    assert.equal(slotsOf("2026-11-18", NOW), 37); // 03:00 → 00:00…03:00 共 37 格
    assert.equal(slotsOf("2026-11-19", NOW), 0);
  });

  test("summarizeBuckets：每天的格數、合計、尖峰與尖峰時間", () => {
    const r = summarizeBuckets([{ bucket: B("2026-11-17", 1), n: 3 }, { bucket: String(B("2026-11-17", 2)), n: "7" }, { bucket: B("2026-11-16", 23, 55), n: 2 }]);
    assert.deepEqual(r, [
      { day: "2026-11-16", buckets: 1, total: 2, peak: 2, peakAt: B("2026-11-16", 23, 55) },
      { day: "2026-11-17", buckets: 2, total: 10, peak: 7, peakAt: B("2026-11-17", 2) },
    ]);
  });

  test("表都不存在：回空的，不建表，也不查 Analytics Engine 以外的東西", async () => {
    const { q, log } = fakeDb([]);
    const r = await telemetryStats({ q, now: NOW, ae: null, days: 14 });
    assert.deepEqual(r.heartbeat, []);
    assert.deepEqual(r.blocked, []);
    assert.deepEqual(r.tables, { heartbeat: false, blocked: false });
    assert.equal(r.recent.configured, false);
    assert.equal(r.from, "2026-11-05");
    assert.equal(r.to, "2026-11-18");
    noDdl(log);
  });

  test("Neon 的歷史＋Analytics Engine 的今天、昨天：同一天用 Analytics Engine 的；平均＝合計 ÷ 這天的格數", async () => {
    const neonBuckets = [
      { bucket: B("2026-11-16", 1), n: 10 }, { bucket: B("2026-11-16", 2), n: 30 },
      { bucket: B("2026-11-17", 1), n: 999 }, // 昨天在 Neon 也有（舊的），要被 Analytics Engine 的取代
    ];
    let params = null;
    const { q, log } = fakeDb(["telemetry_heartbeat", "telemetry_blocked"], (query, p) => {
      if (/from telemetry_heartbeat where bucket >= \$1 group by bucket/.test(query)) { params = p; return neonBuckets; }
      if (/from telemetry_heartbeat/.test(query)) return [
        { d: String(Date.parse("2026-11-16") / 86_400_000), country: "TW", total: 30, peak: 20 },
        { d: String(Date.parse("2026-11-16") / 86_400_000), country: "SG", total: 10, peak: 10 },
        { d: String(Date.parse("2026-11-17") / 86_400_000), country: "TW", total: 999, peak: 999 },
      ];
      if (/from telemetry_blocked/.test(query)) return [{ day: "2026-11-16", country: "TW", n: 4 }, { day: "2026-11-17", country: "TW", n: 99 }];
      return [];
    });
    const sent = [];
    const ae = async (query) => {
      sent.push(query);
      if (/blob1 = 'heartbeat'/.test(query)) return [
        { b: B("2026-11-17", 5) / 1000, country: "TW", n: "6" }, { b: B("2026-11-17", 5) / 1000, country: "HK", n: 4 },
        { b: B("2026-11-18", 1) / 1000, country: "TW", n: 2 },
        { b: B("2026-11-16", 23, 55) / 1000, country: "TW", n: 50 }, // 前天的格子：不要
        { b: B("2026-11-18", 2) / 1000, country: "bad", n: 9 }, // 國家格式不對：不要
      ];
      if (/blob1 = 'blocked'/.test(query)) return [{ d: Date.parse("2026-11-17") / 1000, country: "TW", n: 3 }, { d: Date.parse("2026-11-18") / 1000, country: "JP", n: 1 }];
      return [];
    };
    const r = await telemetryStats({ q, now: NOW, ae, dataset: "bb_telemetry", days: 14 });
    assert.equal(params[0], Date.parse("2026-11-05T00:00:00Z"));
    noDdl(log);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => /FROM bb_telemetry WHERE/.test(s) && /LIMIT \d+$/.test(s)));
    assert.match(sent[0], /toDateTime\('2026-11-16 23:57:30'\)/, "昨天的第一格從前天 23:57:30 起算（跟每日彙總一樣）");
    assert.deepEqual(r.recent, { configured: true, days: ["2026-11-17", "2026-11-18"] });
    assert.deepEqual(r.heartbeat.map((d) => [d.day, d.source, d.total, d.peak, d.slots]), [
      ["2026-11-16", "neon", 40, 30, 288], ["2026-11-17", "ae", 10, 10, 288], ["2026-11-18", "ae", 2, 2, 37],
    ]);
    assert.equal(r.heartbeat[0].avg, 40 / 288);
    assert.deepEqual(r.countries.map((c) => [c.day, c.country, c.total, c.peak]), [
      ["2026-11-16", "SG", 10, 10], ["2026-11-16", "TW", 30, 20], ["2026-11-17", "HK", 4, 4], ["2026-11-17", "TW", 6, 6], ["2026-11-18", "TW", 2, 2],
    ]);
    assert.deepEqual(r.blocked, [{ day: "2026-11-16", country: "TW", n: 4 }, { day: "2026-11-17", country: "TW", n: 3 }, { day: "2026-11-18", country: "JP", n: 1 }]);
  });

  test("Analytics Engine 查詢失敗：照樣回 Neon 的歷史，註明錯誤", async () => {
    const { q } = fakeDb(["telemetry_heartbeat", "telemetry_blocked"], (query) => (/group by bucket/.test(query) ? [{ bucket: B("2026-11-17", 1), n: 5 }] : []));
    const r = await telemetryStats({ q, now: NOW, ae: async () => { throw new Error("analytics_engine_403 no"); }, dataset: "bb_telemetry" });
    assert.equal(r.recent.configured, true);
    assert.match(r.recent.error, /analytics_engine_403/);
    assert.deepEqual(r.heartbeat.map((d) => [d.day, d.source, d.total]), [["2026-11-17", "neon", 5]]);
  });

  test("recentFromAe 拒絕奇怪的 dataset 或日期（會拼進 SQL）；兩個環境的 dataset 名稱", async () => {
    await assert.rejects(recentFromAe(async () => [], "bb; drop", "2026-11-17"));
    await assert.rejects(recentFromAe(async () => [], "bb_telemetry", "2026-11-17'"));
    assert.deepEqual(TELEMETRY_DATASETS, { prod: "bb_telemetry", staging: "bb_telemetry_staging" });
  });
});
