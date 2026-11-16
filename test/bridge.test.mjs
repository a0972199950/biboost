import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, plain, closeAll } from "./helpers/load.mjs";

const A = "upos-sz-mirror08ct.bilivideo.com";
const B = "upos-sz-mirrorcos.bilivideo.com";
function boot(storage, url = "https://www.bilibili.com/video/BV1xx") {
  const env = createEnv({ url, storage: { cdnHost: A, autoSpeedHosts: [A, B], ...storage } });
  env.load("bridge.js");
  return env;
}
function autotestDone(env, payload) {
  env.postMessage({ __cdnSwitcher: 1, dir: "autotest-done", payload });
}

describe("config sync to MAIN world", () => {
  test("startup writes the merged config into page localStorage", () => {
    const env = boot({});
    const cfg = JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__"));
    assert.equal(cfg.cdnHost, A);
    assert.equal(cfg.enabled, true, "default filled in");
    assert.equal(cfg.stVideoMb, 8);
    assert.equal("uiLang" in cfg, false, "only DEFAULTS keys are pushed");
    env.close();
  });
  test("storage changes are pushed again", () => {
    const env = boot({});
    env.chrome.storage.local.set({ cdnHost: B });
    assert.equal(JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__")).cdnHost, B);
    env.close();
  });
});

describe("autotest-done → storage", () => {
  test("stall optimization with the switch off is ignored", () => {
    const env = boot({ autoFallback: false });
    autotestDone(env, { host: B, from: A, reason: "stall" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("a stall result is never written to the settings (the rescue applies in its own tab only), even with the switch on", () => {
    const env = boot({});
    autotestDone(env, { host: B, from: A, reason: "stall" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("install test applies regardless of the switch — but only after a real pending test armed it", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    assert.equal(env.storage.installTestPending, false, "flag cleared on start");
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, B);
    assert.equal("videoEnabled" in env.storage, false, "never forced from a page message");
    autotestDone(env, { host: A, from: B, reason: "install" });
    assert.equal(env.storage.cdnHost, B, "arming is single-use");
    env.close();
  });
  const hideTab = (env) => Object.defineProperty(env.window.document, "visibilityState", { configurable: true, get: () => "hidden" });
  test("install test dropped because the tab went hidden (autotest-end rerun): the flag goes back to storage and this frame is disarmed", () => {
    const env = boot({ installTestPending: true });
    hideTab(env);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    assert.equal(env.storage.installTestPending, false);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, true, "any foreground tab can take it over");
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A, "disarmed: a late or forged result is not applied");
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } }); // 補測
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, B);
    env.close();
  });
  // 審查 F5：autotest-end 晚到、分頁已經切回前景：測的期間進過背景，照樣把旗標還回去
  test("the tab went hidden during the install test but is visible again when the late rerun arrives: still handed back", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    hideTab(env); env.window.document.dispatchEvent(new env.window.Event("visibilitychange"));
    Object.defineProperty(env.window.document, "visibilityState", { configurable: true, get: () => "visible" });
    env.window.document.dispatchEvent(new env.window.Event("visibilitychange"));
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, true);
    env.close();
  });
  test("the next install test in this frame does not inherit the previous one's hidden spell", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    hideTab(env); env.window.document.dispatchEvent(new env.window.Event("visibilitychange"));
    Object.defineProperty(env.window.document, "visibilityState", { configurable: true, get: () => "visible" });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, true);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } }); // 前景補測
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } }); // 前景時的 rerun = 偽造
    assert.equal(env.storage.installTestPending, false);
    env.close();
  });
  test("picture-in-picture during the install test counts as background for the hand-back", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    Object.defineProperty(env.window.document, "pictureInPictureElement", { configurable: true, get: () => ({}) });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, true);
    env.close();
  });
  test("a forged rerun without a real armed test does not create a pending test", () => {
    const env = boot({});
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, undefined);
    env.close();
  });
  test("a rerun while the tab is visible is forged (a real one only comes from a hidden tab): ignored, but it still disarms", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, false, "not handed back: rescue in every tab would stay off otherwise");
    env.close();
  });
  test("rerun after the user changed the mode (same node, e.g. list → custom) is not handed back either", () => {
    const env = boot({ installTestPending: true, cdnMode: "list" });
    hideTab(env);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    env.chrome.storage.local.set({ cdnMode: "custom" });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, false);
    env.close();
  });
  test("rerun after the user picked a node themselves during the test: the flag is not given back (their choice cancels the install optimization)", () => {
    const env = boot({ installTestPending: true });
    hideTab(env);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    env.chrome.storage.local.set({ cdnHost: B, installTestPending: false }); // popup 選節點
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } });
    assert.equal(env.storage.installTestPending, false);
    assert.equal(env.storage.cdnHost, B);
    env.close();
  });
  test("an install test that ended normally without a new pick disarms: a later forged rerun or result does nothing", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install" } }); // 目前節點就達標：沒有 autotest-done
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end", payload: { reason: "install", rerun: 1 } }); // 之後偽造
    assert.equal(env.storage.installTestPending, false);
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("CDN_SWITCHER_CLEAR_AUTO from the popup is relayed to the page as auto-clear", () => {
    const env = boot({});
    const posted = [];
    env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m.dir); };
    let resp;
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_CLEAR_AUTO" }, (r) => { resp = r; });
    assert.deepEqual(posted, ["auto-clear"]);
    assert.equal(resp.ok, true);
    env.close();
  });
  test("closing the speed-test page (port disconnect) stops the test and tells the page the popup's test is over; the removed stop-optimization message does nothing", () => {
    const env = boot({});
    const posted = [];
    env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m.dir); };
    let onDisc = null;
    const port = { name: "cdn-switcher-speedtest", onDisconnect: { addListener: (fn) => { onDisc = fn; } } };
    env.onConnectListeners.forEach((fn) => fn(port));
    onDisc();
    assert.deepEqual(posted, ["speedtest-stop", "speedtest-closed"]);
    posted.length = 0;
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_STOP_AUTOTEST" });
    assert.deepEqual(posted, []);
    env.close();
  });
  test("speed-test page heartbeat: no progress poll for 5 s after a manual test → the page is told it closed (Safari may not send onDisconnect)", async () => {
    const env = boot({});
    const posted = [];
    env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m.dir); };
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_RUN_SPEEDTEST", hosts: [A] });
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_GET_SPEEDTEST" });
    await env.settle(1500);
    assert.ok(!posted.includes("speedtest-closed"));
    await env.settle(5500);
    assert.ok(posted.includes("speedtest-closed"));
    assert.ok(posted.includes("speedtest-stop"), "the manual test is stopped too");
    assert.equal(env.internals("bridge").speedTest().running, false);
    env.close();
  });
  test("forged install result without a pending test is ignored (only a fresh install sets installTestPending)", () => {
    const env = boot({});
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A, "forged autotest-start does not arm it either");
    env.close();
  });
  test("any other reason (e.g. the removed per-video test) is ignored", () => {
    const env = boot({});
    autotestDone(env, { host: B, from: A, reason: "video" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("user changed the node meanwhile (from mismatch) → not overwritten", () => {
    const env = boot({});
    autotestDone(env, { host: B, from: "something.else", reason: "install" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("forged result with a host outside autoSpeedHosts is rejected (page scripts can post this)", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 2 } });
    autotestDone(env, { host: "attacker.example", from: A, reason: "install" });
    autotestDone(env, { host: "attacker.example", from: A, reason: "stall" });
    assert.equal(env.storage.cdnHost, A);
    assert.equal("videoEnabled" in env.storage, false);
    env.close();
  });
  test("autoSpeedHosts missing or malformed → nothing is applied", () => {
    const env = boot({ autoSpeedHosts: "oops" });
    autotestDone(env, { host: B, from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("missing host is ignored", () => {
    const env = boot({});
    autotestDone(env, { from: A, reason: "install" });
    assert.equal(env.storage.cdnHost, A);
    env.close();
  });
  test("result is journaled to background", () => {
    const env = boot({});
    autotestDone(env, { host: B, from: A, reason: "stall" });
    const j = env.runtimeMessages.find((m) => m.type === "CDN_SWITCHER_JOURNAL" && m.entry.k === "ui.speedtest");
    assert.equal(j.entry.d.phase, "apply");
    assert.equal(j.entry.d.host, B);
    env.close();
  });
  test("autotest-start for the install test clears the pending flag", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 3, maxMs: 20000 } });
    assert.equal(env.storage.installTestPending, false);
    const st = plain(env.internals("bridge").latestAutoTest());
    assert.ok(st.startedAt > 0);
    delete st.startedAt;
    assert.deepEqual(st, { running: true, reason: "install", total: 3, done: 0, maxMs: 20000 });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-progress", payload: { done: 2 } });
    assert.equal(env.internals("bridge").latestAutoTest().done, 2);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-end" });
    assert.equal(env.internals("bridge").latestAutoTest().running, false);
    env.close();
  });
  test("overlay past its maximum duration is reported as finished even without autotest-end", () => {
    const env = boot({ installTestPending: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 10, maxMs: 55000 } });
    const ask = () => { let got; env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_GET_DEBUG" }, (r) => { got = r; }); return got.autoTest; };
    assert.equal(ask().running, true);
    env.internals("bridge").latestAutoTest().startedAt -= 56000;
    assert.equal(ask().running, false);
    env.close();
  });
  test("missing or absurd maxMs falls back to the 10-minute cap", () => {
    const env = boot({});
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 10, maxMs: 1e12 } });
    assert.equal(env.internals("bridge").latestAutoTest().maxMs, 600000);
    env.postMessage({ __cdnSwitcher: 1, dir: "autotest-start", payload: { reason: "install", total: 10 } });
    assert.equal(env.internals("bridge").latestAutoTest().maxMs, 600000);
    env.close();
  });
});

describe("import from URL hash (speed test tool)", () => {
  test("valid hash → hosts handed to background, hash removed, lowercased, capped at 50", () => {
    const env = boot({});
    const br = env.internals("bridge");
    const many = Array.from({ length: 60 }, (_, i) => `h${i}.bilivideo.com`);
    env.window.history.replaceState(null, "", "/video/BV1xx#cdnsw-import=1." + ["UPOS-SZ-MIRROR08CT.bilivideo.com"].concat(many).join(","));
    br.importFromHash();
    const msg = env.runtimeMessages.find((m) => m.type === "CDN_SWITCHER_IMPORT_CUSTOM");
    assert.equal(msg.hosts.length, 50);
    assert.equal(msg.hosts[0], "upos-sz-mirror08ct.bilivideo.com");
    assert.equal(env.window.location.hash, "");
    env.close();
  });
  test("IMPORT_RE rejects other versions and unsafe characters", () => {
    const env = boot({});
    const re = env.internals("bridge").IMPORT_RE;
    assert.equal(re.test("#cdnsw-import=1.a.bilivideo.com,b.bilivideo.com"), true);
    assert.equal(re.test("#cdnsw-import=2.a.bilivideo.com"), false);
    assert.equal(re.test("#cdnsw-import=1.<script>"), false);
    assert.equal(re.test("#cdnsw-import=1.a.com/b"), false);
    assert.equal(re.test("#cdnsw-import=1."), false);
    assert.equal(re.test("#other"), false);
    env.close();
  });
  test("no matching hash → nothing sent", () => {
    const env = boot({});
    env.window.history.replaceState(null, "", "/video/BV1xx#t=12");
    env.internals("bridge").importFromHash();
    assert.equal(env.runtimeMessages.some((m) => m.type === "CDN_SWITCHER_IMPORT_CUSTOM"), false);
    assert.equal(env.window.location.hash, "#t=12", "unrelated hash is kept");
    env.close();
  });
});

describe("speed test state for the popup", () => {
  test("live progress merges by route; video progress appends", () => {
    const env = boot({});
    let resp;
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_RUN_LIVE_SPEEDTEST", limits: { runs: 2, sec: 5 } }, (r) => { resp = r; });
    assert.deepEqual(plain(resp), { ok: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "ov", host: "d1--ov-gotcha07.bilivideo.com", startup: { avg: 100 } } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "ov", host: "d1--ov-gotcha07.bilivideo.com", sustain: { lag: 0 } } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "cn", host: "d1--cn-gotcha07.bilivideo.com", error: "timeout" } });
    let st = env.internals("bridge").speedTest();
    assert.equal(st.running, true);
    assert.equal(st.total, 4);
    assert.deepEqual(plain(st.results), [{ route: "ov", host: "d1--ov-gotcha07.bilivideo.com", startup: { avg: 100 }, sustain: { lag: 0 } }, { route: "cn", host: "d1--cn-gotcha07.bilivideo.com", error: "timeout" }]);

    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_RUN_SPEEDTEST", hosts: [A, B] }, () => {});
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { host: A, bps: 1 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { host: A, bps: 2 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-done", payload: {} });
    st = env.internals("bridge").speedTest();
    assert.equal(st.total, 2);
    assert.equal(st.results.length, 2, "no route → appended, not merged");
    assert.equal(st.running, false);
    let got;
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_GET_SPEEDTEST" }, (r) => { got = r; });
    assert.equal(got.speedTest.results.length, 2);
    env.close();
  });
  test("progress rows that are not part of the current run are dropped", () => {
    const env = boot({});
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_RUN_SPEEDTEST", hosts: [A, "my.own.host"] }, () => {});
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { host: "attacker.example", bps: 9e9 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { bps: 1 } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { host: "my.own.host", bps: 1 } });
    assert.deepEqual(plain(env.internals("bridge").speedTest().results), [{ host: "my.own.host", bps: 1 }], "custom hosts from the popup are fine");
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_RUN_LIVE_SPEEDTEST" }, () => {});
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "xx", host: "d1--ov-gotcha07.bilivideo.com", startup: { avg: 1 } } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "ov", host: "attacker.example", startup: { avg: 1 } } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "ov", host: "d1--ov-gotcha07.bilivideo.com", startup: { avg: 1 } } });
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "cnb", host: "cn-gotcha05b.some-other-cdn.net", startup: { avg: 1 } } });
    assert.equal(env.internals("bridge").speedTest().results.length, 2, "live hosts may use any domain suffix, like main-hook's LIVE_HOST_RE");
    env.postMessage({ __cdnSwitcher: 1, dir: "speedtest-progress", payload: { route: "ov", host: "attacker-bilivideo.com", startup: { avg: 1 } } });
    assert.equal(env.internals("bridge").speedTest().results.length, 2);
    env.close();
  });
  test("GET_DEBUG returns the latest MAIN snapshot and pokes MAIN to probe live routes", () => {
    const env = boot({});
    env.postMessage({ __cdnSwitcher: 1, dir: "debug", payload: { currentCdn: A } });
    let got;
    env.chrome.runtime.sendMessage({ type: "CDN_SWITCHER_GET_DEBUG" }, (r) => { got = r; });
    assert.equal(got.debug.currentCdn, A);
    assert.ok(env.runtimeMessages.some((m) => m.type === "CDN_SWITCHER_SNAPSHOT"), "top frame snapshot forwarded to background");
    env.close();
  });
  test("journal / sample from MAIN are forwarded to background", () => {
    const env = boot({});
    env.postMessage({ __cdnSwitcher: 1, dir: "journal", payload: { t: 1, k: "x", d: {} } });
    env.postMessage({ __cdnSwitcher: 1, dir: "sample", payload: { t: 1, spd: 5 } });
    assert.ok(env.runtimeMessages.some((m) => m.type === "CDN_SWITCHER_JOURNAL" && m.entry.k === "x"));
    assert.ok(env.runtimeMessages.some((m) => m.type === "CDN_SWITCHER_SAMPLE" && m.row.spd === 5));
    env.close();
  });
  test("messages from other windows are ignored", () => {
    const env = boot({});
    env.window.dispatchEvent(new env.window.MessageEvent("message", { data: { __cdnSwitcher: 1, dir: "debug", payload: { currentCdn: "evil" } }, source: null }));
    assert.equal(env.internals("bridge").latestDebug(), null);
    env.close();
  });
});

after(closeAll);

describe("no node list yet", () => {
  test("the extension stays off: enabled=false and no node is pushed", () => {
    const env = createEnv({ url: "https://www.bilibili.com/video/BV1xx", storage: {}, cdnList: false });
    env.load("bridge.js");
    const cfg = JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__"));
    assert.equal(cfg.enabled, false);
    assert.equal("cdnHost" in cfg, false);
    assert.ok(env.runtimeMessages.some((m) => m.type === "CDN_SWITCHER_CDN_LIST"), "asks background to check");
    env.close();
  });
  test("even a user who turned it on stays off until the list arrives, then switches on", () => {
    const env = createEnv({ url: "https://www.bilibili.com/video/BV1xx", storage: { enabled: true, cdnHost: A }, cdnList: false });
    env.load("bridge.js");
    assert.equal(JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__")).enabled, false);
    env.chrome.storage.local.set({ cdnListMeta: { v: 1, defaultHost: B, checkedAt: Date.now() } });
    const cfg = JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__"));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.cdnHost, A, "the user's own node is kept");
    env.close();
  });
  test("never-chosen node → the list's global default", () => {
    const env = createEnv({ url: "https://www.bilibili.com/video/BV1xx", storage: {} });
    env.load("bridge.js");
    const cfg = JSON.parse(env.window.localStorage.getItem("__CDN_SWITCHER_CFG__"));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.cdnHost, env.storage.cdnListMeta.defaultHost);
    env.close();
  });
});

describe("buttons on the page's notices", () => {
  test("'turn off' on the frequent-switch notice turns auto-optimize off globally", () => {
    const env = boot({ autoFallback: true });
    env.postMessage({ __cdnSwitcher: 1, dir: "auto-fallback-off" });
    assert.equal(env.storage.autoFallback, false);
    env.close();
  });
  test("'re-test' asks the background to open the popup, at most once per 10 s, and logs whether it opened", () => {
    const env = boot({});
    env.chrome.runtime.onMessage.addListener((msg, sender, respond) => { if (msg.type === "CDN_SWITCHER_OPEN_SPEEDTEST") { respond({ popup: false, why: "user gesture" }); return true; } });
    env.postMessage({ __cdnSwitcher: 1, dir: "open-speedtest" });
    env.postMessage({ __cdnSwitcher: 1, dir: "open-speedtest" });
    assert.equal(env.runtimeMessages.filter((m) => m.type === "CDN_SWITCHER_OPEN_SPEEDTEST").length, 1);
    const logged = env.runtimeMessages.filter((m) => m.type === "CDN_SWITCHER_JOURNAL" && m.entry.k === "ui.term").map((m) => m.entry.d);
    assert.deepEqual(plain(logged), [{ retest: 1, popup: 0, why: "user gesture" }]);
    env.close();
  });
});
