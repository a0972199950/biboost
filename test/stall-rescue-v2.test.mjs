// 卡頓救援 v2（2026-11-16 定案）：以畫面元素判斷卡頓、救援只作用在前景分頁。
// 時間用可調的時鐘（window.Date.now = 真實時間 + offset）：測速的假 fetch 還是要真的經過幾毫秒才算得出速度
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, plain, closeAll } from "./helpers/load.mjs";

after(closeAll);

const VIDEO_URL = "https://www.bilibili.com/video/BV1xx411c7mD";
const HOST = "upos-sz-mirror08ct.bilivideo.com";
const HW = "upos-sz-mirrorhw.bilivideo.com";
const COS = "upos-sz-mirrorcos.bilivideo.com";
const ALI = "upos-sz-mirrorali.bilivideo.com";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function playurl(cid = 3, bandwidth = 800000) {
  return {
    code: 0, data: {
      quality: 80,
      dash: {
        video: [{ id: 80, bandwidth, baseUrl: `https://${COS}/upgcxcode/1/2/${cid}/v80.m4s?deadline=${FUTURE}&x=1`, backupUrl: [`https://${ALI}/upgcxcode/1/2/${cid}/v80.m4s`] }],
        audio: [{ id: 30280, baseUrl: `https://${COS}/upgcxcode/1/2/${cid}/a.m4s`, backupUrl: [] }]
      }
    }
  };
}
function setVideo(v, props) {
  for (const [k, val0] of Object.entries(props)) {
    let val = val0;
    if (k === "buffered") val = val0 ? { length: 1, start: () => val0[0], end: () => val0[1] } : { length: 0, start() {}, end() {} };
    if (k === "played") val = { length: val0 ? 1 : 0, start: () => 0, end: () => 1 };
    Object.defineProperty(v, k, { configurable: true, get: () => val, set() {} });
  }
}
// 播放器 DOM（2026-11-16 實測的結構）：容器 > video-area > perch > video-wrap > video，加上狀態區、載入畫面、錯誤畫面
function addPlayer(env, video = {}) {
  const d = env.window.document;
  const c = d.createElement("div"); c.className = "bpx-player-container";
  c.innerHTML = '<div class="bpx-player-video-area"><div class="bpx-player-video-perch"><div class="bpx-player-video-wrap"></div></div></div>' +
    '<div class="bpx-player-state-wrap"><div class="bpx-player-state-play"></div></div>' +
    '<div class="bpx-player-loading-panel"></div>' +
    '<div class="bpx-player-error-sign"><div class="bpx-player-error-sign-code"></div></div>' +
    '<div class="bpx-player-control-wrap"><div class="bpx-player-ctrl-play" role="button"></div><div class="bpx-player-progress-wrap"></div><div class="bpx-player-ctrl-quality"></div></div>';
  const v = d.createElement("video");
  setVideo(v, { paused: false, ended: false, currentTime: 10, readyState: 4, buffered: [0, 60], played: true, seeking: false, duration: 600, playbackRate: 1, ...video });
  c.querySelector(".bpx-player-video-wrap").appendChild(v);
  d.body.appendChild(c);
  return {
    c, v,
    buff(on) { c.classList.toggle("bpx-state-buff", on); },
    load(on) { c.querySelector(".bpx-player-loading-panel").classList.toggle("bpx-state-loading", on); },
    err(text) { c.querySelector(".bpx-player-error-sign-code").textContent = text || ""; c.classList.toggle("bpx-player-error-sign-active", text != null); }
  };
}
// 測速用的假 fetch：speeds[host] = "fast"（一次給 9 MB）｜數字（約 30 ms 給這麼多 bytes）｜"403"｜沒列 = 一直等
function speedFetch(env, speeds) {
  const asked = [];
  env.fetchHandler = (url) => {
    const host = new URL(url).host;
    asked.push(host);
    const sp = speeds[host];
    if (sp === undefined) return new Promise(() => {});
    if (sp === "403") return { ok: false, status: 403 };
    let sent = false;
    return { ok: true, status: 206, body: { getReader: () => ({ cancel() {},
      read: () => sent ? Promise.resolve({ done: true })
        : new Promise((r) => setTimeout(() => { sent = true; r({ done: false, value: { length: sp === "fast" ? 9e6 : sp } }); }, sp === "fast" ? 5 : 30))
    }) } };
  };
  return asked;
}
function capturePosts(env) {
  const posted = [];
  env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m); };
  return posted;
}
const of = (posted, dir) => posted.filter((m) => m.dir === dir).map((m) => m.payload);
const journal = (posted, k) => posted.filter((m) => m.dir === "journal" && m.payload.k === k).map((m) => m.payload.d);

// 碼率 800 kbps → floor 150 kB/s、good 200 kB/s。「fast」遠超過；1000（約 33 kB/s）不到 floor；60000（約 2 MB/s）達 good
function boot(cfg = {}, { url = VIDEO_URL, session } = {}) {
  const env = createEnv({ url });
  env.window.localStorage.setItem("__CDN_SWITCHER_CFG__", JSON.stringify({ cdnHost: HOST, autoSpeedHosts: [HOST, HW, COS], ...cfg }));
  if (session) for (const [k, v] of Object.entries(session)) env.window.sessionStorage.setItem(k, v);
  let offset = 0;
  const realNow = Date.now;
  env.window.Date.now = () => realNow() + offset;
  env.load("main-hook.js");
  const mh = env.internals("main-hook");
  mh.stopTick();
  const posted = capturePosts(env);
  const clk = {
    now: () => env.window.Date.now(),
    add(ms) { offset += ms; },
    // 每秒跑一次偵測，共 ms 毫秒
    run(ms, each) { for (let t = 0; t < ms; t += 1000) { offset += 1000; if (each) each(); mh.rescueTick(); } }
  };
  return { env, mh, posted, clk };
}
// 開好播放器、解析過 playurl（有測速樣本、碼率）的分頁，順播中
function bootPlaying(cfg, opts) {
  const b = boot(cfg, opts);
  b.p = addPlayer(b.env);
  b.mh.rewriteRoot(playurl(), "playurl");
  b.mh.trackVideoEvents();
  b.mh.rescueTick();
  return b;
}
async function roundEnded(env, mh) {
  for (let i = 0; i < 300 && mh.round(); i++) await env.settle(10);
  if (mh.round()) assert.fail("救援測速沒有在 3 秒內結束");
}
// 影片照常往前走 ms 毫秒（每秒 +1 秒）
function playFor(b, ms) { let ct = b.p.v.currentTime; b.clk.run(ms, () => { ct += 1; setVideo(b.p.v, { currentTime: ct, buffered: [0, ct + 40] }); }); }

describe("entry 1: stalls read from the player's classes", () => {
  test("a stall only counts once the stuck state has lasted 1 s; its start goes back to when the class appeared", () => {
    const b = bootPlaying();
    const t0 = b.clk.now();
    b.p.buff(true); b.mh.uiSample(t0);
    assert.equal(b.mh.e1.ep.start, t0);
    assert.equal(b.mh.e1Stats(t0 + 500).n, 0);
    b.clk.run(1000);
    assert.equal(b.mh.e1.ep.estAt, t0 + 1000);
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 1);
    b.env.close();
  });
  test("5 s of stalling in total triggers the rescue (≈6 s after the video really froze); 4 s does not", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(4000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round(), "rescue test started");
    assert.equal(b.mh.round().src, 1);
    assert.equal(b.mh.isFailed(HOST), true, "entry 1 marks the current node until the video changes");
    assert.equal(b.mh.FALLBACK.failed[HOST], Infinity);
    b.env.close();
  });
  test("the loading screen (TV logo) and error 3001 are stuck states too; another error code is only logged", () => {
    const b = bootPlaying();
    b.p.load(true); b.mh.uiSample(b.clk.now());
    assert.equal(b.mh.UI.stuck, "load");
    b.p.load(false); b.mh.uiSample(b.clk.now());
    b.p.err("错误码：3001"); b.mh.uiSample(b.clk.now());
    assert.equal(b.mh.UI.stuck, "err", "only the digits are compared (the label is localized)");
    b.p.err("錯誤碼：-404"); b.mh.uiSample(b.clk.now());
    assert.equal(b.mh.UI.stuck, "");
    assert.deepEqual(plain(journal(b.posted, "ui.errsign")).map((d) => d.code), ["404"]);
    b.env.close();
  });
  test("the classes are read, never the element's existence: an idle player with all elements present is not stuck", () => {
    const b = bootPlaying();
    b.clk.run(20000);
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.UI.missing, false);
    b.env.close();
  });
  test("a paused video without a stuck class is not a stall (the player's own pause on a dead network is not counted)", () => {
    const b = bootPlaying();
    setVideo(b.p.v, { paused: true });
    b.p.c.classList.add("bpx-state-paused");
    b.clk.run(60000);
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.round(), null);
    b.env.close();
  });
  test("flicker and the player's own 0.5 s skip stay in the same stall: the gap counts and the 1 s is not restarted", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    const start = b.mh.e1.ep.start;
    b.clk.run(1000);
    b.p.buff(false); b.mh.uiSample(b.clk.now());
    setVideo(b.p.v, { currentTime: 10.5 }); // 小跳
    b.clk.run(1000);
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(1000);
    assert.equal(b.mh.e1.ep.start, start, "same stall");
    assert.ok(b.mh.e1Stats(b.clk.now()).ms >= 3000, "the gap counted");
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 1);
    b.env.close();
  });
  test("resuming needs 2 s of steady progress; the stall ends where the progress began (the 2 s are not stall time)", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(2000);
    b.p.buff(false); b.mh.uiSample(b.clk.now());
    const resumedAt = b.clk.now();
    playFor(b, 1000);
    assert.ok(b.mh.e1.ep, "1 s of progress is not enough");
    playFor(b, 2000);
    assert.equal(b.mh.e1.ep, null);
    const st = b.mh.e1Stats(b.clk.now());
    assert.equal(st.n, 1);
    assert.ok(st.ms <= resumedAt - (resumedAt - 2000) + 1100, "about 2–3 s of stall, not 5");
    b.env.close();
  });
  test("pausing (or ending) while stuck ends the stall when the class goes away, so it cannot pile up to a false trigger", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(2000);
    setVideo(b.p.v, { paused: true });
    b.p.buff(false); b.mh.uiSample(b.clk.now()); // 按下暫停，緩衝 class 立刻消失
    b.clk.run(1000);
    assert.equal(b.mh.e1.ep, null);
    b.clk.run(60000);
    assert.equal(b.mh.round(), null);
    assert.ok(b.mh.e1Stats(b.clk.now()).ms < 3500);
    b.env.close();
  });
  test("3 stalls within 3 minutes trigger, counted by when each one was established; older ones drop out", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    const stall = () => { b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(1000); b.p.buff(false); b.mh.uiSample(b.clk.now()); playFor(b, 3000); };
    stall(); playFor(b, 4000); stall();
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 2);
    playFor(b, 170000);
    stall();
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 2, "the first one dropped out of the 3 minutes");
    assert.equal(b.mh.round(), null, "only 2 within the window");
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(1000);
    assert.ok(b.mh.round(), "the third one inside the window triggers as soon as it is established");
    b.env.close();
  });
  test("after any trigger the count and time start over; while entry 1's test runs nothing is counted, and a stall still going on counts from the end of the test", async () => {
    const b = bootPlaying({ autoSpeedHosts: [HOST, HW] });
    speedFetch(b.env, { [HW]: 1000 }); // HW 不到 floor：不換
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(5000);
    assert.ok(b.mh.round());
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 0, "reset at the trigger");
    b.clk.run(3000);
    assert.equal(b.mh.e1Stats(b.clk.now()).ms, 0, "not counted during the test");
    await roundEnded(b.env, b.mh);
    // 測完全部、沒有 ≥ floor、還卡著 → 終態
    assert.ok(b.mh.term(), "terminal prompt");
    b.env.close();
  });
  test("the counters reset on a node change and a new video", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(3000);
    assert.ok(b.mh.e1Stats(b.clk.now()).ms > 0);
    b.mh.applyRescuePick(HW, "test");
    assert.equal(b.mh.e1.eps.length, 0);
    assert.ok(b.mh.FALLBACK.coolUntil > b.clk.now() + 29000, "30 s cool-down");
    b.mh.rewriteRoot(playurl(9), "playurl");
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.FALLBACK.coolUntil, 0);
    b.env.close();
  });
  test("a gap of more than 3 s in sampling (sleep, throttling) restarts the running timers", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(3000);
    b.clk.add(60000); // 電腦睡了一分鐘
    b.mh.rescueTick();
    assert.ok(b.mh.e1.ep.start >= b.clk.now() - 10, "the stall counts from now");
    assert.equal(b.mh.round(), null);
    b.env.close();
  });
  test("no class ever (region-locked video: playurl -10403, nothing shown) is not a stall", () => {
    const b = boot();
    addPlayer(b.env, { readyState: 0, paused: true, played: false, currentTime: 0, buffered: null });
    b.clk.run(60000);
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.BLACK.base, 0, "no segment request went out");
    b.env.close();
  });
});

describe("entry 1: user actions", () => {
  test("a stall that appears within 8 s of the last action does not count; if it is still there at 8 s, it starts at that moment", () => {
    const b = bootPlaying();
    const op = b.clk.now();
    b.mh.noteUserOp("test", op);
    b.clk.add(1000); // 不要超過 3 秒沒取樣（那會被當成取樣中斷、排除期重算）
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    assert.equal(b.mh.e1.ep.start, op + 8000);
    b.clk.run(7000);
    assert.equal(b.mh.e1.ep.estAt, 0, "not established before 8 s + 1 s");
    b.clk.run(1000);
    assert.equal(b.mh.e1.ep.estAt, op + 9000);
    b.env.close();
  });
  test("cool-down: any action, even after the stall began, pauses everything for 8 s from that action (user 2026-11-16)", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(3000);
    b.mh.noteUserOp("test", b.clk.now()); // 卡住 3 秒時使用者又點了一下
    assert.equal(b.mh.rescueBlocked(b.clk.now()), "user-op");
    b.clk.run(7000);
    assert.equal(b.mh.round(), null);
    b.clk.run(5000);
    assert.equal(b.mh.round(), null, "counts from the end of the cool-down");
    b.clk.run(2000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("a seek that recovers within 8 s is never counted", () => {
    const b = bootPlaying();
    b.mh.noteUserOp("test", b.clk.now());
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(3000);
    b.p.buff(false); b.mh.uiSample(b.clk.now());
    playFor(b, 3000);
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 0);
    b.env.close();
  });
  test("clicks on player controls count (capture phase, closest); keys: only space and left/right, never while typing", () => {
    const b = bootPlaying();
    const d = b.env.window.document;
    const n = () => b.mh.userOps().length;
    d.querySelector(".bpx-player-ctrl-play").dispatchEvent(new b.env.window.MouseEvent("click", { bubbles: true }));
    assert.equal(n(), 1);
    d.querySelector(".bpx-player-state-wrap").dispatchEvent(new b.env.window.MouseEvent("click", { bubbles: true }));
    assert.equal(n(), 1, "not a listed control");
    const key = (target, k) => target.dispatchEvent(new b.env.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    key(d.body, " "); key(d.body, "ArrowRight"); key(d.body, "f");
    assert.equal(n(), 3);
    const ta = d.createElement("textarea"); d.body.appendChild(ta);
    key(ta, " "); key(ta, "ArrowLeft");
    const inp = d.createElement("input"); d.body.appendChild(inp);
    key(inp, " ");
    assert.equal(n(), 3, "typing in the comment / danmaku box does not count");
    b.env.close();
  });
  test("seeking more than 1 s counts as an action; the player's own 0.5 s skip does not; the first seek after a load (resume position) does not", () => {
    const b = boot();
    const p = addPlayer(b.env, { currentTime: 0 });
    b.mh.trackVideoEvents();
    const n = () => b.mh.userOps().length;
    setVideo(p.v, { currentTime: 300 }); p.v.dispatchEvent(new b.env.window.Event("seeking"));
    assert.equal(n(), 0, "resume to the last position after load");
    setVideo(p.v, { currentTime: 301 }); p.v.dispatchEvent(new b.env.window.Event("timeupdate"));
    setVideo(p.v, { currentTime: 301.5 }); p.v.dispatchEvent(new b.env.window.Event("seeking"));
    assert.equal(n(), 0, "0.5 s skip");
    setVideo(p.v, { currentTime: 400 }); p.v.dispatchEvent(new b.env.window.Event("seeking"));
    assert.equal(n(), 1, "a real jump");
    b.env.close();
  });
  test("a seek right after a load, after the video already played, still counts (first jump after 5 minutes of playback)", () => {
    const b = boot();
    const p = addPlayer(b.env, { currentTime: 0 });
    b.mh.trackVideoEvents();
    setVideo(p.v, { currentTime: 0.5 }); p.v.dispatchEvent(new b.env.window.Event("timeupdate")); // 開始前進
    setVideo(p.v, { currentTime: 120 }); p.v.dispatchEvent(new b.env.window.Event("seeking"));
    assert.equal(b.mh.userOps().length, 1);
    b.env.close();
  });
});

describe("entry 1: black screen backup (no prompt at all)", () => {
  function bootBlack() {
    const b = boot();
    b.mh.rewriteRoot(playurl(), "playurl");
    b.p = addPlayer(b.env, { readyState: 0, paused: true, currentTime: 0, buffered: null });
    b.mh.trackVideoEvents();
    speedFetch(b.env, {});
    return b;
  }
  test("readyState 0, segments requested but no data: 8 s from the latest of (readyState 0, first request) triggers the rescue", () => {
    const b = bootBlack();
    b.mh.rescueTick();
    b.mh.noteSegReq(b.clk.now());
    b.clk.run(7000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round(), "treated as entry 1 reaching its threshold");
    b.env.close();
  });
  test("an action before the wait pushes the start to 8 s after it (8 s cool-down)", () => {
    const b = bootBlack();
    const op = b.clk.now();
    b.mh.noteUserOp("test", op);
    b.clk.add(1000);
    b.mh.rescueTick();
    b.mh.noteSegReq(b.clk.now());
    b.mh.rescueTick();
    assert.equal(b.mh.BLACK.base, op + 8000);
    b.clk.run(14000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("data arriving resets it", () => {
    const b = bootBlack();
    b.mh.rescueTick();
    b.mh.noteSegReq(b.clk.now());
    b.clk.run(3000);
    b.mh.setLastSampleAt(b.clk.now());
    b.clk.run(1000);
    assert.equal(b.mh.BLACK.base, 0);
    b.env.close();
  });
  test("after a rescue that did not switch, it counts 8 s again from the end of the test", async () => {
    const b = bootBlack();
    speedFetch(b.env, { [HW]: 1000, [COS]: 1000 });
    b.mh.rescueTick(); b.mh.noteSegReq(b.clk.now());
    b.clk.run(8000);
    assert.ok(b.mh.round());
    b.clk.run(2000);
    await roundEnded(b.env, b.mh);
    assert.ok(b.mh.term(), "still black after testing every candidate → terminal");
    b.env.close();
  });
});

describe("entry 2: prediction", () => {
  test("needs 30 s of continuous playback; a pause, waiting or seek starts the 30 s over", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    playFor(b, 20000);
    b.p.v.dispatchEvent(new b.env.window.Event("waiting"));
    playFor(b, 20000);
    setVideo(b.p.v, { buffered: [0, b.p.v.currentTime + 2] }); // 緩衝不到 3 秒
    b.clk.run(2000);
    assert.equal(b.mh.round(), null, "only ~20 s continuous");
    b.env.close();
  });
  test("low buffer (< 3 s for 1 s, segments fine) after 30 s: the current node is tested first; ≥ floor → no switch, no lock, back to watching", async () => {
    const b = bootPlaying();
    const asked = speedFetch(b.env, { [HOST]: "fast", [HW]: "fast" });
    playFor(b, 31000);
    const ct = b.p.v.currentTime;
    let t = ct;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 2] }); });
    assert.ok(b.mh.round());
    assert.equal(b.mh.round().src, 2);
    await roundEnded(b.env, b.mh);
    assert.deepEqual(asked, [HOST], "stops after the current node");
    assert.equal(b.mh.autoHost(), null);
    assert.equal(b.mh.e2.locked, false);
    assert.equal(b.mh.isFailed(HOST), false, "entry 2 never marks the current node first");
    assert.equal(b.mh.e2.last.kept, true);
    b.env.close();
  });
  test("the next round on the same node waits 60 s", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HOST]: "fast" });
    let t = 10;
    const low = (ms) => b.clk.run(ms, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 2] }); });
    playFor(b, 31000); t = b.p.v.currentTime;
    low(2000);
    await roundEnded(b.env, b.mh);
    low(30000);
    assert.equal(b.mh.round(), null);
    low(31000);
    assert.ok(b.mh.round(), "still low after 60 s → test again");
    b.mh.abortRescue("test"); await b.env.settle(20);
    b.env.close();
  });
  test("current node below floor → candidates; low buffer at the end → switch (this tab only) and mark the old node", async () => {
    const b = bootPlaying();
    const asked = speedFetch(b.env, { [HOST]: 1000, [HW]: "fast" });
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    await roundEnded(b.env, b.mh);
    assert.deepEqual(asked, [HOST, HW]);
    assert.equal(b.mh.autoHost(), HW);
    assert.equal(b.mh.isFailed(HOST), true);
    assert.deepEqual(of(b.posted, "autotest-done"), [], "settings untouched");
    b.env.close();
  });
  test("buffer back above 3 s when the rescue test ends: no switch, no lock; a recent segment failure keeps the pick as a standby", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HOST]: 1000, [HW]: "fast" });
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    b.mh.setSegFailAt(b.clk.now());
    setVideo(b.p.v, { buffered: [0, t + 20] });
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), null);
    assert.equal(b.mh.e2.locked, false);
    assert.equal(b.mh.e2.standby.host, HW);
    b.env.close();
  });
  test("a segment failure with plenty of buffer: test in the background, keep a standby, play on; switch once the buffer drops below 3 s", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HOST]: 1000, [HW]: "fast" });
    playFor(b, 31000);
    b.mh.onSegFailure("http-503");
    playFor(b, 1000);
    assert.equal(b.mh.round().kind, "bg");
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.e2.standby.host, HW);
    assert.equal(b.mh.autoHost(), null, "keeps playing");
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 2] }); });
    assert.equal(b.mh.autoHost(), HW);
    assert.equal(b.mh.isFailed(HOST), true);
    b.env.close();
  });
  test("the standby expires 60 s after it was picked, or after 20 s without a new segment failure", () => {
    const b = bootPlaying();
    const now = b.clk.now();
    b.mh.e2.standby = { host: HW, at: now };
    assert.equal(b.mh.standbyOk(now + 19000), true);
    assert.equal(b.mh.standbyOk(now + 21000), false, "no new failure in 20 s");
    b.mh.setSegFailAt(now + 5000);
    assert.equal(b.mh.standbyOk(now + 50000), true);
    assert.equal(b.mh.standbyOk(now + 61000), false);
    b.env.close();
  });
  test("nothing ≥ floor after testing everything → entry 2 locks; it unlocks only after continuous playback was broken and 30 s passed again", async () => {
    const b = bootPlaying({ autoSpeedHosts: [HOST, HW] });
    speedFetch(b.env, { [HOST]: 1000, [HW]: 1000 });
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.e2.locked, true);
    assert.equal(b.mh.isFailed(HOST), false, "entry 2 does not mark the current node when it gives up");
    assert.equal(b.mh.term(), null, "entry 2 never shows the terminal prompt");
    b.clk.run(40000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    assert.equal(b.mh.e2.locked, true, "the 30 s already running at the lock does not count");
    b.p.v.dispatchEvent(new b.env.window.Event("pause"));
    b.clk.run(31000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    assert.equal(b.mh.e2.locked, false);
    b.mh.abortRescue("test"); await b.env.settle(20);
    b.env.close();
  });
  test("near the end (≤ 3 s left, or buffered to the end) entry 2 does nothing", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    setVideo(b.p.v, { duration: 100 });
    let t = 60;
    b.clk.run(31000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, 100] }); });
    assert.equal(b.mh.nearEndE2(b.p.v), true, "buffered to the end");
    b.mh.onSegFailure("http-503");
    b.clk.run(6000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, 100] }); }); // 剩不到 3 秒時緩衝也不到 3 秒
    assert.ok(t >= 97);
    assert.equal(b.mh.round(), null);
    b.env.close();
  });
  test("an entry 2 round running when entry 1 fires is upgraded: the current node is marked, its result dropped, the candidates tested", async () => {
    const b = bootPlaying();
    const asked = speedFetch(b.env, { [HW]: "fast" }); // HOST 一直等（測速掛著）
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    assert.equal(b.mh.round().src, 2);
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(6000);
    assert.equal(b.mh.round().src, 1, "upgraded, not a second round");
    assert.equal(b.mh.isFailed(HOST), true);
    await roundEnded(b.env, b.mh);
    assert.deepEqual(asked, [HOST, HW]);
    assert.equal(b.mh.autoHost(), HW);
    b.env.close();
  });
  test("entry 1 with a valid standby switches straight to it", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.mh.e2.standby = { host: HW, at: b.clk.now() };
    b.mh.setSegFailAt(b.clk.now());
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(5000);
    assert.equal(b.mh.round(), null, "no new test");
    assert.equal(b.mh.autoHost(), HW);
    b.env.close();
  });
});

describe("rescue test rules", () => {
  test("candidates are the list only (no bilibili backups), minus the current node and failed ones", () => {
    const b = bootPlaying();
    assert.deepEqual(plain(b.mh.listCands()), [HW, COS]);
    b.mh.markFailed(HW, 60000);
    assert.deepEqual(plain(b.mh.listCands()), [COS]);
    b.env.close();
  });
  test("good is 2× the bitrate: a node at ~2 MB/s on a 800 kbps video is taken at once", async () => {
    const b = bootPlaying();
    const asked = speedFetch(b.env, { [HW]: 60000, [COS]: "fast" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    await roundEnded(b.env, b.mh);
    assert.deepEqual(asked, [HW]);
    assert.equal(b.mh.autoHost(), HW);
    b.env.close();
  });
  test("below floor or given up → failed for 1 minute; the node that failed in real playback → until the video changes", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HW]: 1000, [COS]: "fast" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), COS);
    const now = b.clk.now();
    assert.ok(b.mh.FALLBACK.failed[HW] > now && b.mh.FALLBACK.failed[HW] <= now + 61000);
    assert.equal(b.mh.FALLBACK.failed[HOST], Infinity);
    b.env.close();
  });
  test("an empty list counts as candidates used up", () => {
    const b = bootPlaying({ autoSpeedHosts: [HOST] });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.ok(b.mh.term(), "still stuck → terminal");
    b.env.close();
  });
  test("nothing testable (no sample yet): no switch, no mark, no terminal; retried on the next trigger", () => {
    const b = boot();
    b.p = addPlayer(b.env);
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.equal(b.mh.round(), null);
    assert.equal(b.mh.term(), null);
    assert.equal(b.mh.isFailed(HOST), false);
    assert.ok(journal(b.posted, "fb.noSample").length >= 1);
    b.env.close();
  });
  test("a node that never sends headers is given up after 2.5 s and marked failed for a minute; the next fast one is taken", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [COS]: "fast" }); // HW 一直不回應標頭
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    for (let i = 0; i < 400 && b.mh.round(); i++) await b.env.settle(10);
    assert.equal(b.mh.autoHost(), COS);
    assert.ok(b.mh.isFailed(HW));
    assert.ok(b.mh.FALLBACK.failed[HW] < Infinity);
    b.env.close();
  });
  test("a rescue in progress is dropped when the tab is hidden, the switch is turned off, a manual test starts, the video changes or the user picks a node", async () => {
    for (const how of ["hidden", "off", "manual-test", "next-video", "manual"]) {
      const b = bootPlaying();
      speedFetch(b.env, { [HW]: "fast" });
      b.env.fetchHandler = ((orig) => (u, i) => new Promise((r) => setTimeout(() => r(orig(u, i)), 40)))(b.env.fetchHandler);
      b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
      assert.ok(b.mh.round(), how);
      if (how === "hidden") { Object.defineProperty(b.env.window.document, "visibilityState", { configurable: true, get: () => "hidden" }); b.env.window.document.dispatchEvent(new b.env.window.Event("visibilitychange")); }
      if (how === "off") b.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { autoFallback: false } });
      if (how === "manual-test") b.env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-run", payload: { hosts: [] } });
      if (how === "next-video") b.mh.rewriteRoot(playurl(7), "playurl");
      if (how === "manual") b.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: ALI } });
      await roundEnded(b.env, b.mh);
      await b.env.settle(80);
      assert.notEqual(b.mh.autoHost(), HW, how + ": not applied");
      b.env.close();
    }
  });
});

describe("terminal prompt", () => {
  async function bootExhausted(stillStuck = true) {
    const b = bootPlaying({ autoSpeedHosts: [HOST, HW] });
    speedFetch(b.env, { [HW]: 1000 });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    if (!stillStuck) { b.p.buff(false); b.mh.uiSample(b.clk.now()); playFor(b, 3000); }
    await roundEnded(b.env, b.mh);
    return b;
  }
  test("shown only while this stall has not recovered; inside the player container, with a 10 s countdown", async () => {
    const b = await bootExhausted(true);
    const el = b.env.window.document.getElementById("cdn-switcher-terminal");
    assert.ok(el);
    assert.equal(el.parentElement, b.p.c);
    assert.match(el.textContent, /所有節點都不流暢/);
    b.env.close();
  });
  test("recovered during the test: no prompt; 'used up' is remembered — the next entry 1 shows it at once without testing; entry 2 is off", async () => {
    const b = await bootExhausted(false);
    assert.equal(b.mh.term(), null);
    assert.equal(b.mh.FALLBACK.exhausted, true);
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.ok(b.mh.term());
    assert.equal(b.mh.round(), null);
    b.env.close();
  });
  test("while shown, detection is paused; hidden pauses the countdown; time up = keep watching: no more optimization for this video", async () => {
    const b = await bootExhausted(true);
    assert.equal(b.mh.rescueBlocked(b.clk.now()), "prompt");
    Object.defineProperty(b.env.window.document, "visibilityState", { configurable: true, get: () => "hidden" });
    b.clk.add(20000); b.mh.termTick(b.clk.now());
    assert.ok(b.mh.term(), "countdown paused in the background");
    Object.defineProperty(b.env.window.document, "visibilityState", { configurable: true, get: () => "visible" });
    b.mh.termTick(b.clk.now());
    for (let i = 0; i < 11; i++) { b.clk.add(1000); b.mh.termTick(b.clk.now()); }
    assert.equal(b.mh.term(), null);
    assert.equal(b.mh.FALLBACK.noMore, true);
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(30000);
    assert.equal(b.mh.round(), null, "no rescue for this video any more");
    assert.equal(b.mh.term(), null);
    b.env.close();
  });
  test("a manual node change brings optimization back (cool-down first) and closes a prompt that is showing", async () => {
    const b = await bootExhausted(true);
    b.mh.termChoose("continue", "test");
    b.mh.setLastSegReqAt(b.clk.now()); // 已經在播（抓過分段）：換節點有冷靜期
    b.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(b.mh.FALLBACK.noMore, false);
    assert.ok(b.mh.FALLBACK.coolUntil > b.clk.now());
    const c = await bootExhausted(true);
    c.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(c.mh.term(), null);
    b.env.close(); c.env.close();
  });
  test("'stop intervening': the tab's sessionStorage flag is set and the page reloads; after the reload nothing is rewritten and settings never reload it", async () => {
    const b = await bootExhausted(true);
    b.mh.termChoose("disable", "click");
    assert.equal(b.env.window.sessionStorage.getItem("__CDN_SWITCHER_NO_INTERVENE__"), "1");
    b.env.close();
    const r = boot({}, { session: { "__CDN_SWITCHER_NO_INTERVENE__": "1" } });
    assert.equal(r.mh.noIntervene(), true);
    const root = playurl();
    r.mh.rewriteRoot(root, "playurl");
    const calls = [];
    r.env.window.player = { reload: () => calls.push("reload"), getCurrentTime: () => 30, seek() {} };
    addPlayer(r.env);
    r.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    r.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { enabled: false } });
    assert.deepEqual(calls, [], "no player reload");
    assert.equal(r.mh.rescueBlocked(r.clk.now()), "inactive");
    r.env.close();
  });
});

describe("preconditions and pauses", () => {
  test("background tab, picture-in-picture, the switch off, not a watch page: nothing is detected", () => {
    const cases = [
      ["hidden", (b) => Object.defineProperty(b.env.window.document, "visibilityState", { configurable: true, get: () => "hidden" })],
      ["pip", (b) => Object.defineProperty(b.env.window.document, "pictureInPictureElement", { configurable: true, get: () => b.p.v })],
      ["off", (b) => { b.mh.cfg().autoFallback = false; }]
    ];
    for (const [name, apply] of cases) {
      const b = bootPlaying();
      speedFetch(b.env, {});
      apply(b);
      b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(20000);
      assert.equal(b.mh.round(), null, name);
      assert.equal(b.mh.isFailed(HOST), false, name);
      b.env.close();
    }
    const h = boot({}, { url: "https://www.bilibili.com/" });
    addPlayer(h.env); h.mh.rewriteRoot(playurl(), "playurl");
    assert.equal(h.mh.rescueBlocked(h.clk.now()), "page");
    h.env.close();
  });
  test("coming back to the foreground: a stall in progress counts from that moment", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    const doc = b.env.window.document;
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(10000);
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
    doc.dispatchEvent(new b.env.window.Event("visibilitychange"));
    b.clk.run(4000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("pressing the popup's manual test pauses everything in that tab until the test page closes", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-run", payload: { hosts: [] } });
    b.env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-stop" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(20000);
    assert.equal(b.mh.round(), null);
    b.env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-closed" });
    b.clk.run(4000);
    assert.equal(b.mh.round(), null, "counts from when the popup closed");
    b.clk.run(1000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("cool-down: 30 s after any node change nothing triggers; a stall still going on counts from the end", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.mh.setLastSegReqAt(b.clk.now());
    b.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(29000);
    assert.equal(b.mh.round(), null);
    b.clk.run(5000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("the install optimization pending or running: no rescue (it comes first)", () => {
    const b = bootPlaying({ installTestPending: true });
    speedFetch(b.env, {});
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(20000);
    assert.equal(b.mh.round(), null);
    assert.equal(b.mh.rescueBlocked(b.clk.now()), "off");
    b.env.close();
  });
  test("a rescue switch never reaches the settings (other tabs are not reloaded), and is shown as this tab's temporary node", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HW]: "fast" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), HW);
    assert.equal(b.mh.cfg().cdnHost, HOST);
    assert.deepEqual(of(b.posted, "autotest-done"), []);
    b.env.close();
  });
});

describe("video change and missing player UI", () => {
  test("a cid that cannot be read keeps the last one: the reload during a rescue is not a new video", () => {
    const b = bootPlaying();
    b.env.window.player = { getManifest: () => ({ cid: 3 }) };
    b.mh.checkVideoKey();
    b.mh.markFailed(HW, Infinity);
    b.env.window.player = { getManifest: () => null }; // 播放器重載中
    b.mh.checkVideoKey();
    assert.equal(b.mh.isFailed(HW), true);
    b.env.window.player = { getManifest: () => ({ cid: 5 }) };
    b.mh.checkVideoKey();
    assert.equal(b.mh.isFailed(HW), false, "a different valid cid starts over");
    b.env.close();
  });
  test("the player UI is missing for 10 s+ on a watch page (bilibili redesign) → ui.missing, the old detection until the video changes", () => {
    const b = boot();
    b.mh.rewriteRoot(playurl(), "playurl");
    const v = b.env.window.document.createElement("video");
    setVideo(v, { paused: false, currentTime: 10, readyState: 4, buffered: [0, 10.2], played: true, duration: 600 });
    b.env.window.document.body.appendChild(v);
    b.clk.run(14000);
    assert.equal(b.mh.UI.missing, true);
    assert.equal(journal(b.posted, "ui.missing").length, 1);
    b.mh.rewriteRoot(playurl(8), "playurl");
    assert.equal(b.mh.UI.missing, false, "checked again for the new video");
    b.env.close();
  });
  test("in the old-detection mode, the old limits apply with the new rules (frozen while playing → 5 s)", () => {
    const b = boot();
    b.mh.rewriteRoot(playurl(), "playurl");
    speedFetch(b.env, {});
    const v = b.env.window.document.createElement("video");
    setVideo(v, { paused: false, currentTime: 10, readyState: 4, buffered: [0, 10.2], played: true, duration: 600 });
    b.env.window.document.body.appendChild(v);
    b.clk.run(14000);
    assert.equal(b.mh.UI.missing, true);
    b.clk.run(7000);
    assert.ok(b.mh.round(), "frozen 5 s+ → rescue");
    b.env.close();
  });
});

describe("review round 1", () => {
  test("a stuck class that is already there when the video changes starts a new stall for the new video", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.p.load(true); b.mh.uiSample(b.clk.now()); // 自動連播：載入畫面先出現
    b.clk.run(1000);
    b.mh.rewriteRoot(playurl(9), "playurl"); // 新影片的 cid 才進來
    assert.equal(b.mh.e1.ep, null);
    b.clk.run(1000);
    assert.ok(b.mh.e1.ep, "the loading screen still showing counts for the new video");
    b.clk.run(5000);
    assert.ok(b.mh.round(), "and it triggers");
    b.env.close();
  });
  test("a 0.3 s flash of the class is not a stall, even though the gap until recovery is longer than 1 s", () => {
    const b = bootPlaying();
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.add(300); b.p.buff(false); b.mh.uiSample(b.clk.now());
    playFor(b, 3000);
    assert.equal(b.mh.e1.ep, null);
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 0);
    b.env.close();
  });
  test("a stall that starts and ends inside the cool-down is not counted", () => {
    const b = bootPlaying();
    b.mh.setLastSegReqAt(b.clk.now());
    b.mh.applyRescuePick(HW, "test");
    b.p.load(true); b.mh.uiSample(b.clk.now());
    b.clk.run(3000);
    b.p.load(false); b.mh.uiSample(b.clk.now());
    playFor(b, 3000);
    playFor(b, 30000);
    assert.equal(b.mh.e1Stats(b.clk.now()).n, 0);
    b.env.close();
  });
  test("a throttled background tab coming back: the stall counts ~5 s from the return, not 13 s", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    const doc = b.env.window.document;
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.add(60000); b.mh.rescueTick(); // 背景：一分鐘才一次
    b.clk.add(30000);
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
    doc.dispatchEvent(new b.env.window.Event("visibilitychange"));
    b.clk.run(4000);
    assert.equal(b.mh.round(), null);
    b.clk.run(1000);
    assert.ok(b.mh.round());
    b.env.close();
  });
  test("fallback mode (ui.missing): candidates used up while still frozen → terminal prompt", async () => {
    const b = boot({ autoSpeedHosts: [HOST, HW] });
    b.mh.rewriteRoot(playurl(), "playurl");
    speedFetch(b.env, { [HW]: 1000 });
    const v = b.env.window.document.createElement("video");
    setVideo(v, { paused: false, currentTime: 10, readyState: 4, buffered: [0, 10.2], played: true, duration: 600 });
    b.env.window.document.body.appendChild(v);
    b.clk.run(20000);
    assert.equal(b.mh.UI.missing, true);
    await roundEnded(b.env, b.mh);
    assert.ok(b.mh.term(), "still frozen → prompt, not just 'used up'");
    b.env.close();
  });
  test("with a standby ready, a user seek into unbuffered video (buffer 0) does not switch; paused does not either", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    playFor(b, 31000);
    b.mh.e2.standby = { host: HW, at: b.clk.now() };
    b.mh.setSegFailAt(b.clk.now());
    b.mh.noteUserOp("seek", b.clk.now());
    setVideo(b.p.v, { buffered: [0, b.p.v.currentTime] });
    b.clk.run(3000);
    assert.equal(b.mh.autoHost(), null);
    setVideo(b.p.v, { paused: true });
    b.clk.run(6000);
    assert.equal(b.mh.autoHost(), null);
    b.env.close();
  });
  test("typing in a shadow-DOM comment box (composedPath) is not a user action; a held arrow key is logged once", () => {
    const b = bootPlaying();
    const d = b.env.window.document;
    const host = d.createElement("div"); d.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const ta = d.createElement("textarea"); root.appendChild(ta);
    ta.dispatchEvent(new b.env.window.KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }));
    assert.equal(b.mh.userOps().length, 0);
    for (let i = 0; i < 20; i++) d.body.dispatchEvent(new b.env.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, repeat: i > 0 }));
    assert.equal(b.mh.userOps().length, 8, "still counted (only the last 8 are kept)");
    assert.equal(journal(b.posted, "ui.op").length, 1);
    b.env.close();
  });
  test("in backup-URL mode entry 2 first measures the node the player is really fetching from (never 'backup')", async () => {
    const b = bootPlaying({ cdnHost: "backup" });
    const asked = speedFetch(b.env, { [ALI]: "fast", [HW]: "fast" });
    b.mh.noteSegment(`https://${ALI}/upgcxcode/1/2/3/v80.m4s`);
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    await roundEnded(b.env, b.mh);
    assert.deepEqual(asked, [ALI], "the real current node first; it is fine → no switch");
    assert.equal(b.mh.autoHost(), null);
    b.env.close();
  });
  test("a sleep gap does not run the prompt's countdown down", async () => {
    const b = bootPlaying({ autoSpeedHosts: [HOST] });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.ok(b.mh.term());
    b.clk.add(600000); b.mh.termTick(b.clk.now());
    assert.ok(b.mh.term(), "woke up: still asking");
    b.env.close();
  });
  test("'stop intervening' tab: the playurl fetch is not rewritten and a settings change logs no page reload", async () => {
    const r = boot({}, { session: { "__CDN_SWITCHER_NO_INTERVENE__": "1" } });
    const body = JSON.stringify(playurl());
    r.env.fetchHandler = () => ({ ok: true, status: 200, statusText: "", headers: new Map(), text: () => Promise.resolve(body), clone() { return this; } });
    const resp = await r.env.window.fetch("https://api.bilibili.com/x/player/wbi/playurl?cid=3");
    const txt = await resp.text();
    assert.ok(txt.includes(COS) && !txt.includes(HOST), "B站's own hosts are kept");
    addPlayer(r.env);
    r.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    r.env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { enabled: false } });
    assert.equal(journal(r.posted, "play.state").filter((d) => d.ev === "reload").length, 0, "neither page nor player reload");
    r.env.close();
  });
});

describe("review round 2", () => {
  test("a background test that ends while the user is dragging (buffer 0): no switch, kept as a standby; the current node is not marked", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HOST]: 1000, [HW]: "fast" });
    playFor(b, 31000);
    b.mh.onSegFailure("http-503");
    playFor(b, 1000);
    assert.equal(b.mh.round().kind, "bg");
    b.mh.noteUserOp("seek", b.clk.now());
    setVideo(b.p.v, { buffered: [0, b.p.v.currentTime] });
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), null);
    assert.equal(b.mh.isFailed(HOST), false);
    assert.equal(b.mh.e2.standby.host, HW);
    b.env.close();
  });
  test("a full-page reload by the rescue carries this video's failed nodes and the cool-down", () => {
    const carry = JSON.stringify({ host: HW, page: "/video/BV1xx411c7mD?p=", failed: [HOST], cool: Date.now() + 20000 });
    const b = boot({}, { session: { "__CDN_SWITCHER_AUTO__": carry } });
    b.mh.rewriteRoot(playurl(), "playurl");
    assert.equal(b.mh.autoHost(), HW);
    assert.equal(b.mh.isFailed(HOST), true);
    assert.ok(b.mh.FALLBACK.coolUntil > b.clk.now());
    b.env.close();
    const other = JSON.stringify({ host: HW, page: "/video/BVother?p=", failed: [HOST], cool: Date.now() + 20000 });
    const c = boot({}, { session: { "__CDN_SWITCHER_AUTO__": other } });
    c.mh.rewriteRoot(playurl(), "playurl");
    assert.equal(c.mh.isFailed(HOST), false, "another page: nothing carried");
    c.env.close();
  });
  test("learning the first cid is not a video change: a rescue already running and the failed marks stay", () => {
    const b = boot();
    addPlayer(b.env);
    b.mh.markFailed(HOST, Infinity);
    b.mh.rewriteRoot(playurl(), "playurl"); // 第一次知道 cid
    assert.equal(b.mh.isFailed(HOST), true);
    b.env.close();
  });
  test("entry 2 with no candidates at all locks instead of retrying (and logging) every 10 s", () => {
    const b = bootPlaying({ cdnHost: "backup", autoSpeedHosts: [] });
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    assert.equal(b.mh.e2.locked, true);
    b.env.close();
  });
  test("an expired sample URL counts as 'cannot test': no prompt, no marks", () => {
    const b = boot();
    b.p = addPlayer(b.env);
    const pu = playurl();
    const past = Math.floor(Date.now() / 1000) - 60;
    pu.data.dash.video[0].baseUrl = pu.data.dash.video[0].baseUrl.replace(/deadline=\d+/, "deadline=" + past);
    b.mh.rewriteRoot(pu, "playurl");
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.equal(b.mh.round(), null);
    assert.equal(b.mh.term(), null);
    assert.equal(b.mh.isFailed(HOST), false);
    b.env.close();
  });
  test("a main-video error event on a video page only logs, never rescues", () => {
    const b = bootPlaying();
    speedFetch(b.env, {});
    b.p.v.dispatchEvent(new b.env.window.Event("error"));
    b.clk.run(2000);
    assert.equal(b.mh.round(), null);
    assert.equal(b.mh.isFailed(HOST), false);
    assert.ok(journal(b.posted, "play.error").length >= 1);
    b.env.close();
  });
  test("the install optimization running: no stall counting; afterwards it counts from the end of that test", async () => {
    const b = bootPlaying({ installTestPending: true, autoSpeedHosts: [HOST, HW] });
    speedFetch(b.env, { [HOST]: "fast", [HW]: "fast" });
    assert.equal(b.mh.runAutoSpeedTest([HOST, HW], "install"), true);
    b.p.buff(true); b.mh.uiSample(b.clk.now());
    b.clk.run(10000);
    assert.equal(b.mh.e1Stats(b.clk.now()).ms, 0);
    for (let i = 0; i < 300 && !of(b.posted, "autotest-end").length; i++) await b.env.settle(10);
    assert.equal(of(b.posted, "autotest-end").length, 1, "the install test ended");
    b.clk.run(4000);
    assert.equal(b.mh.round(), null, "counts from the end of the install test");
    b.clk.run(2000);
    assert.ok(b.mh.round());
    b.mh.abortRescue("test"); await b.env.settle(30);
    b.env.close();
  });
});

describe("user decisions 2026-11-16 (cool-down, silent rescue)", () => {
  test("an entry-2 result that arrives during the cool-down is kept as a standby; the current node is not marked", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HOST]: 1000, [HW]: "fast" });
    playFor(b, 31000);
    let t = b.p.v.currentTime;
    b.clk.run(2000, () => { t += 1; setVideo(b.p.v, { currentTime: t, buffered: [0, t + 1] }); });
    assert.equal(b.mh.round().src, 2);
    b.mh.noteUserOp("test", b.clk.now());
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), null);
    assert.equal(b.mh.isFailed(HOST), false);
    assert.equal(b.mh.e2.standby.host, HW);
    b.env.close();
  });
  test("an entry-1 result that arrives during the cool-down is not applied", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HW]: "fast" });
    b.env.fetchHandler = ((orig) => (u, i) => new Promise((r) => setTimeout(() => r(orig(u, i)), 40)))(b.env.fetchHandler);
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    assert.ok(b.mh.round());
    b.mh.noteUserOp("test", b.clk.now());
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), null);
    b.env.close();
  });
  test("the rescue is silent: no toast on the page, no 'optimizing' messages for the popup", async () => {
    const b = bootPlaying();
    speedFetch(b.env, { [HW]: "fast" });
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(5000);
    await roundEnded(b.env, b.mh);
    assert.equal(b.mh.autoHost(), HW);
    assert.equal(b.env.window.document.getElementById("cdn-switcher-toast"), null);
    assert.deepEqual(of(b.posted, "autotest-start"), []);
    assert.deepEqual(of(b.posted, "autotest-progress"), []);
    b.env.close();
  });
});

describe("pre-push smoke test", () => {
  test("no sample: a stall that keeps triggering logs fb.hit once per video, not every 5 s", () => {
    const b = boot();
    b.p = addPlayer(b.env);
    b.p.buff(true); b.mh.uiSample(b.clk.now()); b.clk.run(60000);
    assert.equal(journal(b.posted, "fb.hit").length, 1);
    assert.equal(journal(b.posted, "fb.noSample").length, 1);
    b.env.close();
  });
});

