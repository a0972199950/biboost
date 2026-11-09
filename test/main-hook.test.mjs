import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, fakeResponse, plain, closeAll } from "./helpers/load.mjs";

const VIDEO_URL = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
const HOST = "upos-sz-mirror08ct.bilivideo.com";
const COS = "upos-sz-mirrorcos.bilivideo.com";
const ALI = "upos-sz-mirrorali.bilivideo.com";
const MCDN = "xy1.mcdn.bilivideo.cn";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

// Boots main-hook.js on a bilibili page with the given config already in localStorage.
// 每秒的 interval 停掉：測試自己呼叫 checkStall／checkHealth，不讓它在 async 測試的空檔自己跑（會多觸發救援、亂改狀態）。
// before(env)：載入前要先放進 window 的東西（例如假的 PerformanceObserver）
function boot(cfg, url = VIDEO_URL, before) {
  const env = createEnv({ url });
  env.window.localStorage.setItem("__CDN_SWITCHER_CFG__", JSON.stringify({ cdnHost: HOST, ...cfg }));
  if (before) before(env);
  env.load("main-hook.js");
  env.internals("main-hook").stopTick();
  return env;
}
// bandwidth：v80 的碼率（bits/s），null = 不給
function playurl(extra, bandwidth = 4000000) {
  return {
    code: 0, data: {
      quality: 80,
      dash: {
        video: [{ id: 80, ...(bandwidth == null ? {} : { bandwidth }), baseUrl: `https://${COS}/upgcxcode/1/2/3/v80.m4s?deadline=${FUTURE}&x=1`, backupUrl: [`https://${ALI}/upgcxcode/1/2/3/v80.m4s`, `https://${MCDN}:4483/upgcxcode/1/2/3/v80.m4s`] },
          { id: 64, baseUrl: `https://${COS}/upgcxcode/1/2/3/v64.m4s`, backupUrl: [] }],
        audio: [{ id: 30280, baseUrl: `https://${COS}/upgcxcode/1/2/3/a.m4s`, backupUrl: [] }]
      }, ...extra
    }
  };
}

describe("pure helpers", () => {
  let env, mh;
  before(() => { env = boot({}); mh = env.internals("main-hook"); });
  after(() => env.close());

  test("boot picks config up from localStorage", () => {
    assert.equal(mh.cfg().cdnHost, HOST);
    assert.equal(mh.cfg().enabled, true);
    assert.equal(mh.effHost(), HOST);
    assert.equal(mh.isHostMode(), true);
    assert.equal(mh.pageTypeOf(), "video");
  });
  test("isExpiredUrl", () => {
    assert.equal(mh.isExpiredUrl(`https://${COS}/a.m4s?deadline=${PAST}`), true);
    assert.equal(mh.isExpiredUrl(`https://${COS}/a.m4s?deadline=${FUTURE}`), false);
    assert.equal(mh.isExpiredUrl(`https://${COS}/a.m4s`), false);
    assert.equal(mh.isExpiredUrl("not a url"), false);
  });
  test("isSegUrl needs both the upgcxcode path and a CDN host", () => {
    assert.equal(mh.isSegUrl("https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/x.m4s"), true);
    assert.equal(mh.isSegUrl(`https://${MCDN}:4483/upgcxcode/1/x.m4s`), false, "port breaks the $ anchor on purpose");
    assert.equal(mh.isSegUrl("https://data.bilibili.com/log?u=https://x/upgcxcode/a.m4s"), false, "tracking beacon that embeds a segment URL");
    assert.equal(mh.isSegUrl(`https://${COS}/other/x.m4s`), false);
    assert.equal(mh.isSegUrl("https://attacker-bilivideo.com/upgcxcode/1/x.m4s"), false, "label boundary");
  });
  test("isSwappableSeg / swapSegHost", () => {
    const akam = `https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/x.m4s?deadline=${FUTURE}`;
    assert.equal(mh.isSwappableSeg(akam), true);
    assert.equal(mh.isSwappableSeg(`https://${HOST}/upgcxcode/1/x.m4s`), false, "already on the target host");
    assert.equal(mh.isSwappableSeg("https://cdn.example.com/upgcxcode/1/x.m4s"), false, "not a bilibili CDN host");
    assert.equal(mh.swapSegHost(akam), `https://${HOST}/upgcxcode/1/x.m4s?deadline=${FUTURE}`);
  });
  test("replaceHost keeps path/query and returns input on garbage", () => {
    assert.equal(mh.replaceHost(`https://${COS}/p/q.m4s?a=1#f`, HOST), `https://${HOST}/p/q.m4s?a=1#f`);
    assert.equal(mh.replaceHost("https://[", HOST), "https://[");
    assert.equal(mh.hostOf(`HTTPS://${COS.toUpperCase()}/x`), COS);
  });
  test("isFailureStatus / shouldFallbackOnStatus", () => {
    assert.equal(mh.isFailureStatus(403), true);
    assert.equal(mh.isFailureStatus(451), true);
    assert.equal(mh.isFailureStatus(503), true);
    assert.equal(mh.isFailureStatus(206), false);
    assert.equal(mh.isFailureStatus(600), false);
    const cur = `https://${HOST}/upgcxcode/1/x.m4s?deadline=${FUTURE}`;
    assert.equal(mh.shouldFallbackOnStatus(403, cur), true);
    assert.equal(mh.shouldFallbackOnStatus(403, `https://${HOST}/upgcxcode/1/x.m4s?deadline=${PAST}`), false, "expired signature is not a CDN failure");
    assert.equal(mh.shouldFallbackOnStatus(500, cur), true);
    assert.equal(mh.shouldFallbackOnStatus(403, `https://${COS}/upgcxcode/1/x.m4s?deadline=${FUTURE}`), false, "other host's failure is not ours");
    assert.equal(mh.shouldFallbackOnStatus(200, cur), false);
  });
  test("clampNum", () => {
    assert.equal(mh.clampNum("50", 1, 100, 8), 50);
    assert.equal(mh.clampNum("abc", 1, 100, 8), 8);
    assert.equal(mh.clampNum(0, 1, 100, 8), 8);
    assert.equal(mh.clampNum(-3, 1, 100, 8), 8);
    assert.equal(mh.clampNum(500, 1, 100, 8), 100);
    assert.equal(mh.clampNum(0.5, 1, 100, 8), 1);
  });
  test("cleanTitle strips the site suffix", () => {
    assert.equal(mh.cleanTitle("Foo_哔哩哔哩_bilibili"), "Foo");
    assert.equal(mh.cleanTitle("Bar - bilibili"), "Bar");
    assert.equal(mh.cleanTitle("  Baz  "), "Baz");
    assert.equal(mh.cleanTitle("_bilibili"), "_bilibili", "never returns empty when input was not empty");
    assert.equal(mh.cleanTitle(42), "");
  });
  test("qnText", () => {
    assert.equal(mh.qnText(), "-");
    mh.debug.lastQn = 80;
    assert.equal(mh.qnText(), "1080P (80)");
    mh.debug.lastQn = 999;
    assert.equal(mh.qnText(), "999");
    mh.debug.lastQn = null;
  });
  test("speed window: direct samples win over resource-timing samples", () => {
    mh.addSample(1024 * 1024, 1000, true);
    mh.addSample(50 * 1024 * 1024, 1000, false); // ignored: a direct sample arrived < 30s ago
    mh.updateSpeed();
    assert.equal(Math.round(mh.debug.speedBps), 1024 * 1024);
    assert.equal(mh.debug.speedIdle, false);
    mh.addSample(0, 1000, true); // no-op
    mh.addSample(10, 0, true); // no-op
  });
});

describe("live helpers", () => {
  let env, mh;
  before(() => { env = boot({}, "https://live.bilibili.com/12345"); mh = env.internals("main-hook"); });
  after(() => env.close());

  test("liveInfo parses gotcha hosts", () => {
    const li = mh.liveInfo("https://d1--ov-gotcha07.bilivideo.com/live-bvc/123/live_123.flv?x=1");
    assert.equal(li.cluster, "07");
    assert.equal(li.route, "ov");
    assert.equal(li.prefix, "d1--");
    assert.equal(li.suffix, ".bilivideo.com");
    assert.equal(li.isStream, true);
    assert.equal(li.isFlv, true);
    const m4s = mh.liveInfo("https://d1--cn-gotcha07b.bilivideo.com/live-bvc/123/x.m4s");
    assert.equal(m4s.route, "cnb");
    assert.equal(m4s.isStream, false);
    assert.equal(mh.liveInfo("https://cn-gotcha07.bilivideo.com/live-bvc/123/x.m3u8").route, "cn");
    assert.equal(mh.liveInfo("https://d1--ov-gotcha07.bilivideo.com/other/x.flv"), null);
    assert.equal(mh.liveInfo("https://upos-sz-mirror08ct.bilivideo.com/live-bvc/x.flv"), null);
    assert.equal(mh.liveInfo("::"), null);
  });
  test("liveHostFor builds every route variant", () => {
    assert.equal(mh.liveHostFor("d1--", "07", ".bilivideo.com", "ov"), "d1--ov-gotcha07.bilivideo.com");
    assert.equal(mh.liveHostFor("d1--", "07", ".bilivideo.com", "ovb"), "d1--ov-gotcha07b.bilivideo.com");
    assert.equal(mh.liveHostFor("d1--", "07", ".bilivideo.com", "cn"), "d1--cn-gotcha07.bilivideo.com");
    assert.equal(mh.liveHostFor("", "05", ".bilivideo.com", "cnb"), "cn-gotcha05b.bilivideo.com");
  });
  test("parseM3u8 resolves segment URLs and the init map", () => {
    const base = "https://d1--ov-gotcha07.bilivideo.com/live-bvc/123/index.m3u8?sig=1";
    const pl = mh.parseM3u8('#EXTM3U\n#EXT-X-MAP:URI="h.m4s"\n#EXTINF:1.5,\n1.m4s\n#EXTINF:2,\nhttps://other/2.m4s\n\n#EXT-X-ENDLIST\n', base);
    assert.equal(pl.map, "https://d1--ov-gotcha07.bilivideo.com/live-bvc/123/h.m4s");
    assert.deepEqual(plain(pl.segs), [
      { url: "https://d1--ov-gotcha07.bilivideo.com/live-bvc/123/1.m4s", dur: 1.5, key: "1.m4s" },
      { url: "https://other/2.m4s", dur: 2, key: "https://other/2.m4s" }
    ]);
    assert.equal(mh.parseM3u8("#EXTM3U\n", base).segs.length, 0);
  });
  test("FlvParser yields tag types/timestamps across chunk boundaries", () => {
    function tag(type, ts, size) {
      const b = new Uint8Array(11 + size + 4);
      b[0] = type; b[1] = (size >> 16) & 255; b[2] = (size >> 8) & 255; b[3] = size & 255;
      b[4] = (ts >> 16) & 255; b[5] = (ts >> 8) & 255; b[6] = ts & 255; b[7] = (ts >> 24) & 255;
      return b;
    }
    const header = new Uint8Array([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
    const stream = new Uint8Array([...header, ...tag(18, 0, 3), ...tag(9, 40, 2), ...tag(8, 41, 1)]);
    const p = new mh.FlvParser();
    let tags = [];
    for (let i = 0; i < stream.length; i += 7) tags = tags.concat(p.push(stream.subarray(i, i + 7)));
    assert.deepEqual(plain(tags), [{ type: 18, ts: 0 }, { type: 9, ts: 40 }, { type: 8, ts: 41 }]);
    assert.equal(p.bad, false);
    assert.deepEqual(tags.map(mh.isAvTag), [false, true, true]);
    const bad = new mh.FlvParser();
    bad.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    assert.equal(bad.bad, true);
  });
  test("playInfoExpires / usablePlayInfo / playInfoKey", () => {
    function info(expires, live = 1, code = 0) {
      return { code, data: { live_status: live, playurl_info: { playurl: { stream: [{ format: [{ codec: [{ url_info: [{ extra: `a=1&expires=${expires}&b=2` }, { extra: `expires=${expires + 100}` }] }] }] }] } } } };
    }
    const now = Math.floor(Date.now() / 1000);
    assert.equal(mh.playInfoExpires(info(1700000000)), 1700000000, "minimum across url_info");
    assert.equal(mh.playInfoExpires({ data: {} }), 0);
    assert.equal(mh.playInfoExpires(info("x")), 0);
    assert.equal(mh.usablePlayInfo(info(now + 3600)), true);
    assert.equal(mh.usablePlayInfo(info(now + 60)), false, "less than 2 minutes left");
    assert.equal(mh.usablePlayInfo(info(now + 3600, 0)), false, "not live");
    assert.equal(mh.usablePlayInfo(info(now + 3600, 1, -400)), false);
    assert.equal(mh.usablePlayInfo(null), false);
    assert.equal(mh.playInfoKey(new URLSearchParams("room_id=1&protocol=0,1&format=0,1,2&codec=0,1")), "1|0|0,1|0,1,2|0,1");
    assert.equal(mh.playInfoKey(new URLSearchParams("room_id=1&qn=10000&protocol=0&format=0&codec=0")), "1|10000|0|0|0");
  });
});

describe("playurl rewriting", () => {
  let env, mh;
  before(() => { env = boot({}); mh = env.internals("main-hook"); });
  after(() => env.close());

  test("dash: base goes to the chosen host, originals become backups, mcdn is not a fallback candidate", () => {
    const root = playurl();
    assert.equal(mh.rewriteRoot(root, "playurl"), true);
    const v = root.data.dash.video[0];
    assert.equal(mh.hostOf(v.baseUrl), HOST);
    assert.equal(new URL(v.baseUrl).search, `?deadline=${FUTURE}&x=1`, "query kept");
    assert.deepEqual(plain(v.backupUrl.map(mh.hostOf)), [COS, ALI, `${MCDN}:4483`]);
    assert.equal(mh.hostOf(root.data.dash.audio[0].baseUrl), HOST);
    assert.deepEqual(plain(mh.backupHosts()), [COS, ALI], "mcdn filtered, order of first appearance");
    assert.equal(mh.debug.playurlGiven, COS);
    assert.equal(mh.debug.lastQn, 80);
    assert.equal(mh.debug.pickVideoHost, HOST);
    assert.equal(mh.debug.pickAudioHost, HOST);
    assert.deepEqual(plain(mh.videoQnByPath()), { "/upgcxcode/1/2/3/v80.m4s": 80, "/upgcxcode/1/2/3/v64.m4s": 64 });
  });
  test("pickFallbackHost (blind switch, only when there is nothing to test with) skips failed hosts", () => {
    mh.FALLBACK.failed = {};
    assert.equal(mh.pickFallbackHost(), COS);
    mh.markFailed(COS);
    assert.equal(mh.pickFallbackHost(), ALI);
    mh.markFailed(ALI);
    assert.equal(mh.pickFallbackHost(), null);
    mh.FALLBACK.failed = {};
  });
  test("pickFallbackHost skips the current host", () => {
    const e2 = boot({ cdnHost: COS });
    const m2 = e2.internals("main-hook");
    m2.rewriteRoot(playurl(), "playurl");
    assert.equal(m2.effHost(), COS);
    assert.equal(m2.pickFallbackHost(), ALI);
    e2.close();
  });
  test("the current quality's bitrate comes from the dash bandwidth", () => {
    assert.equal(mh.currentBitrateBps(), 4000000 / 8);
  });
  test("durl (flv) and snake_case keys", () => {
    const root = { data: { quality: 64, durl: [{ url: `https://${COS}/upgcxcode/1/c.flv`, backup_url: [`https://${ALI}/upgcxcode/1/c.flv`] }] } };
    assert.equal(mh.rewriteRoot(root, "playinfo"), true);
    assert.equal(mh.hostOf(root.data.durl[0].url), HOST);
    assert.deepEqual(plain(root.data.durl[0].backup_url.map(mh.hostOf)), [COS, ALI]);
    assert.equal(mh.debug.lastQn, 64);
  });
  test("pgc / cheese wrap dash under result.video_info", () => {
    const root = { result: { video_info: playurl().data } };
    assert.equal(mh.rewriteRoot(root, "playurl"), true);
    assert.equal(mh.hostOf(root.result.video_info.dash.video[0].baseUrl), HOST);
  });
  test("objects without media are left alone", () => {
    assert.equal(mh.rewriteRoot({ data: { foo: 1 } }, "x"), false);
    assert.equal(mh.rewriteRoot(null, "x"), false);
    assert.equal(mh.rewriteRoot("str", "x"), false);
    assert.equal(mh.applyTrack({}), null);
  });
  test("tryRewriteText only parses texts that look like a playurl", () => {
    assert.equal(mh.tryRewriteText("", "x"), null);
    assert.equal(mh.tryRewriteText("{not json dash", "x"), null);
    assert.equal(mh.tryRewriteText('{"foo":1}', "x"), null);
    const out = mh.tryRewriteText(JSON.stringify(playurl()), "x");
    assert.ok(out.includes(HOST));
    assert.equal(JSON.parse(out).data.dash.video[0].baseUrl.includes(COS), false);
  });
  test("noteBackupHost ignores non-CDN hosts, ports and pcdn", () => {
    mh.setPendingBackupHosts([]);
    mh.noteBackupHost(`https://${COS}/a`);
    mh.noteBackupHost(`https://${COS}/b`);
    mh.noteBackupHost("https://cdn.example.com/a");
    mh.noteBackupHost(`https://${MCDN}/a`);
    mh.noteBackupHost(`https://${ALI}:8080/a`);
    mh.noteBackupHost("");
    assert.deepEqual(plain(mh.getPendingBackupHosts()), [COS]);
    mh.setPendingBackupHosts(null);
    mh.noteBackupHost(`https://${ALI}/a`); // no-op outside a rewrite
    assert.equal(mh.getPendingBackupHosts(), null);
  });
});

describe("backup mode", () => {
  let env, mh;
  before(() => { env = boot({ cdnHost: "backup" }); mh = env.internals("main-hook"); });
  after(() => env.close());

  test("prefers bilibili's own backups and does not swap segments", () => {
    assert.equal(mh.isHostMode(), false);
    assert.equal(mh.isSwappableSeg("https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/x.m4s"), false);
    const root = playurl();
    mh.rewriteRoot(root, "playurl");
    const v = root.data.dash.video[0];
    assert.equal(mh.hostOf(v.baseUrl), ALI);
    assert.equal(mh.hostOf(v.backupUrl[v.backupUrl.length - 1]), COS);
  });
});

describe("fetch hook", () => {
  test("rewrites segment requests to the configured host and samples the download", async () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.fetchHandler = () => fakeResponse({ status: 206, body: "x".repeat(2048) });
    const url = `https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3/v80.m4s?deadline=${FUTURE}`;
    const resp = await env.window.fetch(url);
    assert.equal(resp.status, 206);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(new URL(env.fetchCalls[0].url).host, HOST);
    assert.equal(mh.debug.segRewriteCount, 1);
    await env.settle();
    assert.equal(mh.debug.lastSegMs >= 0, true);
    // Request objects are rewritten too
    await env.window.fetch(new env.window.Request(url));
    assert.equal(new URL(env.fetchCalls[1].url).host, HOST);
    env.close();
  });
  test("non-segment requests pass through untouched", async () => {
    const env = boot({});
    env.fetchHandler = () => fakeResponse({ body: "ok" });
    await env.window.fetch("https://api.bilibili.com/x/web-interface/nav");
    assert.equal(env.fetchCalls[0].url, "https://api.bilibili.com/x/web-interface/nav");
    assert.equal(env.internals("main-hook").debug.segRewriteCount, 0);
    env.close();
  });
  test("playurl responses are rewritten in flight", async () => {
    const env = boot({});
    env.fetchHandler = () => fakeResponse({ body: playurl() });
    const resp = await env.window.fetch("https://api.bilibili.com/x/player/wbi/playurl?bvid=1&cid=2");
    const j = JSON.parse(await resp.text());
    assert.equal(new URL(j.data.dash.video[0].baseUrl).host, HOST);
    assert.equal(env.internals("main-hook").debug.rewriteCount, 1);
    env.close();
  });
  test("disabled: nothing is rewritten", async () => {
    const env = boot({ enabled: false });
    const mh = env.internals("main-hook");
    assert.equal(mh.isActive(mh.cfg()), false);
    env.fetchHandler = () => fakeResponse({ body: playurl() });
    await env.window.fetch(`https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/x.m4s?deadline=${FUTURE}`);
    assert.equal(new URL(env.fetchCalls[0].url).host, "upos-hz-mirrorakam.akamaized.net");
    const resp = await env.window.fetch("https://api.bilibili.com/x/player/playurl?x=1");
    assert.equal(JSON.parse(await resp.text()).data.dash.video[0].baseUrl.includes(COS), true);
    env.close();
  });
  test("videoEnabled=false also disables rewriting", () => {
    const env = boot({ videoEnabled: false });
    const mh = env.internals("main-hook");
    assert.equal(mh.isActive(mh.cfg()), false);
    env.close();
  });
});

describe("config messages from bridge", () => {
  test("only messages from the same window with the marker are accepted", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.window.dispatchEvent(new env.window.MessageEvent("message", { data: { __cdnSwitcher: 1, dir: "config", payload: { showDebug: true } }, source: null }));
    env.postMessage({ dir: "config", payload: { showDebug: true } });
    assert.equal(mh.cfg().showDebug, false);
    env.close();
  });
  test("changing only showDebug updates cfg without a reload", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { showDebug: true, autoFallback: false } });
    assert.equal(mh.cfg().showDebug, true);
    assert.equal(mh.cfg().autoFallback, false);
    assert.equal(mh.cfg().cdnHost, HOST);
    assert.equal(env.window.sessionStorage.getItem("__CDN_SWITCHER_SWITCH_TOAST__"), null);
    env.close();
  });
  test("switching to another named host queues a toast for after the reload (no player API in tests)", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(mh.cfg().cdnHost, COS);
    assert.equal(mh.effHost(), COS);
    assert.ok(env.window.sessionStorage.getItem("__CDN_SWITCHER_SWITCH_TOAST__").includes(COS));
    env.close();
  });
  test("a forged cdnHost that is neither a CDN host nor one of the user's nodes is rejected", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: "attacker.example", showDebug: true } });
    assert.equal(mh.cfg().cdnHost, HOST);
    assert.equal(mh.cfg().showDebug, false, "the whole message is dropped");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: "my.own.host", autoSpeedHosts: ["my.own.host"] } });
    assert.equal(mh.cfg().cdnHost, "my.own.host", "custom hosts arrive together with the list they are in");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: "backup" } });
    assert.equal(mh.cfg().cdnHost, "backup");
    env.close();
  });
  test("isAllowedCdnHost", () => {
    const env = boot({});
    const ok = env.internals("main-hook").isAllowedCdnHost;
    assert.equal(ok(HOST), true);
    assert.equal(ok("upos-hz-mirrorakam.akamaized.net"), true);
    assert.equal(ok("base"), true);
    assert.equal(ok("backup"), true);
    assert.equal(ok("my.own.host", ["my.own.host"]), true);
    assert.equal(ok("my.own.host", []), false);
    assert.equal(ok("my.own.host", "nope"), false);
    assert.equal(ok("evil.bilivideo.com.attacker.example"), false);
    assert.equal(ok("attacker-bilivideo.com"), false, "suffix match must sit on a label boundary");
    assert.equal(ok("bilivideo.com"), true);
    assert.equal(ok(""), false);
    assert.equal(ok(42), false);
    env.close();
  });
  test("unknown keys in the payload are ignored", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { bogus: 1 } });
    assert.equal("bogus" in mh.cfg(), false);
    env.close();
  });
  test("messages pushed by bridge replace the toast strings", () => {
    const env = boot({});
    env.postMessage({ __cdnSwitcher: 1, dir: "messages", payload: { mhToastClose: "Close" } });
    // no direct getter for MSGS; exercising the path is enough to catch a thrown error
    env.close();
  });
});

after(closeAll);

const AKAM = "upos-hz-mirrorakam.akamaized.net";
// Same shape as a real playurl (2026-10): the akamai URL carries an hdnts token bound to that one file
function akamPlayurl(dir = "1/2/3") {
  const cos = (f) => `https://${COS}/upgcxcode/${dir}/${f}?deadline=${FUTURE}&upsig=s`;
  const akam = (f) => `https://${AKAM}/upgcxcode/${dir}/${f}?deadline=${FUTURE}&upsig=s&hdnts=exp=1~hmac=${f}`;
  return {
    code: 0, data: {
      quality: 80,
      dash: {
        video: [{ id: 80, baseUrl: cos("v80.m4s"), backupUrl: [akam("v80.m4s")] }],
        audio: [{ id: 30280, baseUrl: cos("a.m4s"), backupUrl: [akam("a.m4s")] }]
      }
    }
  };
}
// jsdom has no media pipeline: give the page a <video> with the given state
// played：這個 video 播放過沒有（預設 currentTime > 0 就算播過）；props 之後可以用 setVideo 改
function addVideo(env, { paused = true, ended = false, currentTime = 10, buffered = null, readyState = 4, played = currentTime > 0, seeking = false, duration = 600 } = {}) {
  const v = env.window.document.createElement("video");
  setVideo(v, { paused, ended, currentTime, readyState, buffered, played, seeking, duration });
  env.window.document.body.appendChild(v);
  return v;
}
// 測速用的假 fetch：speeds[host] = "fast"（一次給 9 MB）｜數字（約 30 ms 給這麼多 bytes）｜"403"｜沒列 = 一直等（測速掛著）。
// 回傳被問到的 host（依序）
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
        // 「fast」也要過幾毫秒：同一毫秒內讀完的話 measureHost 算出的 ms = 0、速度會記成 0
        : new Promise((r) => setTimeout(() => { sent = true; r({ done: false, value: { length: sp === "fast" ? 9e6 : sp } }); }, sp === "fast" ? 5 : 30))
    }) } };
  };
  return asked;
}
// main-hook 送出去的 window.postMessage（給 bridge 的）收下來看
function capturePosts(env) {
  const posted = [];
  env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m); };
  return posted;
}
function setVideo(v, props) {
  for (const [k, val0] of Object.entries(props)) {
    let val = val0;
    if (k === "buffered") val = val0 ? { length: 1, start: () => val0[0], end: () => val0[1] } : { length: 0, start() {}, end() {} };
    if (k === "played") val = { length: val0 ? 1 : 0, start: () => 0, end: () => 1 };
    Object.defineProperty(v, k, { configurable: true, get: () => val, set() {} });
  }
}

describe("akamai needs its own signed URL", () => {
  test("switching segments to akamai uses bilibili's URL for that file, never a host-swapped one", () => {
    const env = boot({ cdnHost: AKAM });
    const mh = env.internals("main-hook");
    assert.equal(mh.needsOwnSig(AKAM), true);
    assert.equal(mh.needsOwnSig(COS), false);
    const root = akamPlayurl();
    mh.rewriteRoot(root, "playurl");
    assert.ok(root.data.dash.video[0].baseUrl.includes("hmac=v80.m4s"), "baseUrl is the original akamai URL");
    assert.ok(root.data.dash.audio[0].baseUrl.includes("hmac=a.m4s"), "each file keeps its own token");
    const seg = `https://${COS}/upgcxcode/1/2/3/a.m4s?deadline=${FUTURE}&upsig=s`;
    assert.equal(mh.isSwappableSeg(seg), true);
    assert.ok(mh.swapSegHost(seg).includes("hmac=a.m4s"));
    const unknown = `https://${COS}/upgcxcode/9/9/9/other.m4s?deadline=${FUTURE}`;
    assert.equal(mh.isSwappableSeg(unknown), false, "no token for this file: stay on the original host instead of a sure 403");
    env.close();
  });
  test("an akamai node with no akamai URL in the playurl leaves the base untouched", () => {
    const env = boot({ cdnHost: AKAM });
    const mh = env.internals("main-hook");
    const root = playurl();
    mh.rewriteRoot(root, "playurl");
    assert.equal(mh.hostOf(root.data.dash.video[0].baseUrl), COS);
    env.close();
  });
  test("bilivideo nodes still swap the host directly", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    mh.rewriteRoot(akamPlayurl(), "playurl");
    const seg = `https://${AKAM}/upgcxcode/1/2/3/a.m4s?deadline=${FUTURE}&upsig=s&hdnts=x`;
    assert.equal(mh.hostOf(mh.swapSegHost(seg)), HOST);
    env.close();
  });
});

describe("rescue state across playurls and videos", () => {
  test("a new video resets the question and the user's stop; failed marks stay (they follow the network) and expire after 10 minutes", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    mh.FALLBACK.asked = true; mh.FALLBACK.userStopped = true; mh.markFailed(COS);
    mh.rewriteRoot(playurl(), "playurl"); // what player.reload() triggers now
    assert.equal(mh.FALLBACK.asked, true, "same video");
    mh.rewriteRoot(akamPlayurl("4/5/6"), "playurl");
    assert.equal(mh.FALLBACK.asked, false);
    assert.equal(mh.FALLBACK.userStopped, false);
    assert.equal(mh.isFailed(COS), true);
    mh.FALLBACK.failed[COS] = Date.now() - 11 * 60 * 1000;
    assert.equal(mh.isFailed(COS), false);
    env.close();
  });
});

describe("segment failures", () => {
  test("failures with plenty of buffer are deferred, however many; the switch comes once the buffer runs low", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    speedFetch(env, {});
    mh.rewriteRoot(playurl(), "playurl");
    const v = addVideo(env, { paused: false, currentTime: 10, buffered: [0, 32] });
    mh.FALLBACK.holdUntil = 0;
    for (let i = 0; i < 5; i++) mh.onSegFailure("network-error");
    mh.checkSegFailure();
    assert.equal(mh.isFailed(HOST), false, "switching would throw the 22s of buffer away");
    Object.defineProperty(v, "buffered", { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 13 }) });
    mh.checkSegFailure();
    assert.equal(mh.isFailed(HOST), true, "buffer below 5s after a recent failure → rescue");
    env.close();
  });
  test("a deferred failure that is not repeated expires (the player's own retry worked)", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    const v = addVideo(env, { paused: false, currentTime: 10, buffered: [0, 32] });
    mh.FALLBACK.holdUntil = 0;
    mh.onSegFailure("network-error");
    mh.segFail.at = Date.now() - 21000;
    Object.defineProperty(v, "buffered", { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 12 }) });
    mh.checkSegFailure();
    assert.equal(mh.segFail.reason, null);
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("with the buffer nearly gone a single failure switches right away", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, currentTime: 10, buffered: [0, 13] });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.onSegFailure("http-403");
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
});

describe("fallback waits for the install optimization", () => {
  test("pending optimization with a list → no switch; once it has started (flag cleared) the switch works again", () => {
    const env = boot({ installTestPending: true, autoSpeedHosts: [HOST, COS] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, currentTime: 10, buffered: [0, 13] });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.onSegFailure("http-403");
    assert.equal(mh.isFailed(HOST), false, "the optimization will pick a node anyway");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { installTestPending: false } });
    mh.onSegFailure("http-403");
    assert.equal(mh.isFailed(HOST), true, "flag cleared → the rescue runs");
    env.close();
  });
  test("pending but no list to test (nothing will run) → the switch still works", () => {
    const env = boot({ installTestPending: true, autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, currentTime: 10, buffered: [0, 13] });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.onSegFailure("http-403");
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
});

describe("rescue: test the candidates, switch to a fast one, skip failures, ask when they run out", () => {
  const HW = "upos-sz-mirrorhw.bilivideo.com";
  // 目前節點 HOST、清單 [HOST, HW]、B 站備援 [COS, ALI]（mcdn 不算）→ 候選依序 HW、COS、ALI。
  // 碼率預設 800 kbps → 「撐得住畫質」的門檻 = 150 kB/s：數字速度（約 30 ms 給 N bytes）就算計時器被拖慢到 400 ms 也量得出夠不夠
  function bootRescue(speeds, cfg = {}, bandwidth = 800000) {
    const env = boot({ autoSpeedHosts: [HOST, HW], ...cfg });
    const asked = speedFetch(env, speeds);
    const posted = capturePosts(env);
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl({}, bandwidth), "playurl");
    addVideo(env, { paused: false, currentTime: 10, buffered: [0, 10.2] });
    mh.FALLBACK.holdUntil = 0;
    return { env, mh, asked, posted };
  }
  const of = (posted, dir) => posted.filter((m) => m.dir === dir).map((m) => m.payload);
  async function ended(env, posted, n = 1) {
    for (let i = 0; i < 300 && of(posted, "autotest-end").length < n; i++) await env.settle(10);
    if (of(posted, "autotest-end").length < n) assert.fail(`測速第 ${n} 輪沒有在 3 秒內結束`);
  }

  test("candidates: the list plus bilibili's backups, minus the current node and failed ones", () => {
    const { env, mh } = bootRescue({});
    assert.deepEqual(plain(mh.rescueCandidates()), [HW, COS, ALI]);
    mh.markFailed(HW);
    assert.deepEqual(plain(mh.rescueCandidates()), [COS, ALI]);
    env.close();
  });
  test("the current node is not tested again (it just failed in real playback); the first fast list node is written to the settings", async () => {
    const { env, mh, asked, posted } = bootRescue({ [HOST]: "fast", [HW]: "fast", [COS]: "fast" });
    assert.equal(mh.maybeFallback("stalled"), true);
    assert.equal(mh.isFailed(HOST), true);
    await ended(env, posted);
    assert.deepEqual(asked, [HW], "stops at the first node that is fast enough");
    assert.deepEqual(plain(of(posted, "autotest-done")), [{ host: HW, from: HOST, reason: "stall" }]);
    assert.ok(mh.FALLBACK.holdUntil > Date.now(), "grace starts right away, before the settings round-trip");
    env.close();
  });
  test("bilibili's backups are measured too, never switched to blindly; slower ones tested on the way are marked failed", async () => {
    const { env, mh, asked, posted } = bootRescue({ [HW]: 1000, [COS]: "fast" });
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.deepEqual(asked, [HW, COS]);
    assert.equal(mh.autoHost(), COS, "a backup is applied in this tab only");
    assert.deepEqual(of(posted, "autotest-done"), [], "not written to the settings");
    assert.equal(mh.isFailed(HW), true);
    env.close();
  });
  test("still stuck on the new node after the grace → only the untested candidates are tried", async () => {
    const { env, mh, asked, posted } = bootRescue({ [HW]: 1000, [COS]: "fast", [ALI]: "fast" });
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.equal(mh.autoHost(), COS);
    assert.equal(mh.maybeFallback("stalled"), false, "within the grace period");
    mh.FALLBACK.holdUntil = 0;
    asked.length = 0;
    assert.equal(mh.maybeFallback("stalled"), true);
    await ended(env, posted, 2);
    assert.deepEqual(asked, [ALI], "HOST, HW and COS all failed already");
    assert.equal(mh.autoHost(), ALI);
    env.close();
  });
  test("nothing reaches 4K: the fastest wins only if it can carry the current quality (1.5× its bitrate)", async () => {
    // 門檻 150 kB/s：HW 約 0.15～2 MB/s（不到 4K 的 3.1 MB/s，不會提早停）、COS 約 25～330 kB/s → 選最快的 HW
    const { env, mh, posted } = bootRescue({ [HW]: 60000, [COS]: 10000, [ALI]: "403" });
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.deepEqual(plain(of(posted, "autotest-done")), [{ host: HW, from: HOST, reason: "stall" }]);
    env.close();
  });
  test("nothing can carry the quality → no switch, all marked failed; the next stall asks the user", async () => {
    const { env, mh, posted } = bootRescue({ [HW]: 1000, [COS]: 1000, [ALI]: 1000 });
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.equal(mh.autoHost(), null);
    assert.deepEqual(of(posted, "autotest-done"), []);
    assert.deepEqual(plain(mh.rescueCandidates()), []);
    assert.equal(mh.maybeFallback("predicted"), false, "a prediction never pops the question");
    assert.equal(mh.FALLBACK.asked, false);
    assert.equal(mh.maybeFallback("stalled"), true);
    assert.equal(mh.FALLBACK.asked, true);
    assert.equal(mh.maybeFallback("stalled"), false, "asked once");
    env.close();
  });
  test("on a backup, the user's own node can come back once its failure expired (the override is dropped)", async () => {
    const { env, mh, posted } = bootRescue({ [HW]: 1000, [COS]: "fast" });
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.equal(mh.autoHost(), COS);
    mh.FALLBACK.failed[HOST] = Date.now() - 11 * 60 * 1000; // 10 分鐘過了
    const asked = speedFetch(env, { [HOST]: "fast" });
    mh.FALLBACK.holdUntil = 0;
    mh.maybeFallback("stalled");
    await ended(env, posted, 2);
    assert.deepEqual(asked, [HOST], "HW failed, COS is the current one");
    assert.equal(mh.autoHost(), null, "back on the user's node");
    assert.deepEqual(of(posted, "autotest-done"), [], "the settings already say HOST");
    env.close();
  });
  test("the user pressed stop → this video only asks from now on; a manual test taking over changes nothing", async () => {
    // 假 fetch 不理會中止訊號：讓每個節點都會慢慢回資料，這一輪才收得了尾（真的 fetch 被中止會直接結束）
    const a = bootRescue({ [HW]: 1000, [COS]: 1000, [ALI]: 1000 });
    a.mh.maybeFallback("stalled");
    a.mh.stopAutoTest();
    await ended(a.env, a.posted);
    assert.equal(a.mh.FALLBACK.userStopped, true);
    a.mh.FALLBACK.holdUntil = 0;
    a.mh.maybeFallback("stalled");
    assert.equal(a.mh.FALLBACK.asked, true, "no more automatic tests, straight to the question");
    a.env.close();

    const b = bootRescue({ [HW]: 1000 });
    b.mh.maybeFallback("stalled");
    b.mh.runSpeedTest([HW], {});
    await ended(b.env, b.posted);
    assert.equal(b.mh.FALLBACK.userStopped, false);
    assert.equal(b.mh.isFailed(HW), false, "the interrupted round marks nothing");
    b.env.close();
  });
  test("preconditions: no rescue (and nothing marked) when the switch is off, in backup-URL mode, off a watch page, or while a speed test runs", () => {
    const cases = [
      ["autoFallback off", { autoFallback: false }, VIDEO_URL, null],
      ["backup-URL mode", { cdnHost: "backup" }, VIDEO_URL, null],
      ["not a watch page", {}, "https://www.bilibili.com/", null],
      ["speed test running", {}, VIDEO_URL, (mh) => mh.runSpeedTest([HW], {})]
    ];
    for (const [name, cfg, url, prep] of cases) {
      const env = boot({ autoSpeedHosts: [HOST, HW], ...cfg }, url);
      speedFetch(env, {});
      const mh = env.internals("main-hook");
      mh.rewriteRoot(playurl(), "playurl");
      addVideo(env, { paused: false, currentTime: 10, buffered: [0, 10.2] });
      mh.FALLBACK.holdUntil = 0;
      if (prep) prep(mh);
      assert.equal(mh.maybeFallback("stalled"), false, name);
      assert.deepEqual(plain(mh.failedHosts()), [], name + ": nothing marked");
      env.close();
    }
  });
  test("the user changes the node while the rescue is testing → the result is not applied", async () => {
    const { env, mh, posted } = bootRescue({ [HW]: 1000, [COS]: "fast" });
    mh.maybeFallback("stalled");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: "cn-bj-se-01-05.bilivideo.com" } }); // 使用者在 popup 換了
    await ended(env, posted);
    assert.equal(mh.autoHost(), null);
    assert.deepEqual(of(posted, "autotest-done"), []);
    assert.equal(mh.effHost(), "cn-bj-se-01-05.bilivideo.com");
    env.close();
  });
  test("high-bitrate video: a node above 25 Mbps but below 1.5× the bitrate does not stop the search early", async () => {
    const { env, mh } = bootRescue({}, {}, 20000000); // 20 Mbps → 至少 3.75 MB/s
    assert.equal(mh.currentBitrateBps(), 2500000);
    const asked = speedFetch(env, { [HW]: 120000, [COS]: "fast" }); // HW 約 1.5～4 MB/s：不到 good 的 1e8
    let res = null;
    mh.runAutoSpeedTest([HW, COS], "stall", (how, r) => { res = r; }, { good: 1e8, floor: 0 });
    for (let i = 0; i < 300 && !res; i++) await env.settle(10);
    assert.deepEqual(asked, [HW, COS], "HW is below 'good', so COS is tested too");
    assert.equal(res.pick, COS, "the faster one");
    env.close();
  });
  test("no bitrate in the playurl → floor 0: the fastest is taken even if slow", async () => {
    const { env, mh, posted } = bootRescue({ [HW]: 1000, [COS]: 3000, [ALI]: "403" }, {}, null);
    assert.equal(mh.currentBitrateBps(), 0);
    mh.maybeFallback("stalled");
    await ended(env, posted);
    assert.equal(mh.autoHost(), COS);
    env.close();
  });
  test("candidates are de-duplicated, and an akamai node without bilibili's own URL for this file is left out (and cannot be measured)", async () => {
    const AKAM = "upos-hz-mirrorakam.akamaized.net";
    const { env, mh } = bootRescue({}, { autoSpeedHosts: [HOST, HW, COS, AKAM] });
    assert.deepEqual(plain(mh.rescueCandidates()), [HW, COS, ALI], "COS once; AKAM has no own URL in this playurl");
    assert.equal(mh.testUrlFor(AKAM), null);
    const r = await mh.measureHost(AKAM);
    assert.equal(r.error, "no-url");
    env.close();
  });
  test("with bilibili's own akamai URL the akamai node is a candidate and is measured on that URL", () => {
    const AKAM = "upos-hz-mirrorakam.akamaized.net";
    const env = boot({ autoSpeedHosts: [HOST] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(akamPlayurl(), "playurl");
    assert.ok(mh.rescueCandidates().includes(AKAM));
    assert.ok(mh.testUrlFor(AKAM).includes("hmac=v80.m4s"), "the URL bilibili signed for this file");
    env.close();
  });
  test("speed-test requests are not player segments: no line sample, no 'player switched node', no busy fetching", async () => {
    let poCallback = null;
    const env = boot({ autoSpeedHosts: [HOST, HW] }, VIDEO_URL, (e) => {
      e.window.PerformanceObserver = class { constructor(cb) { poCallback = cb; } observe() {} };
    });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    speedFetch(env, { [HW]: 1000 });
    const before = mh.debug.currentCdn;
    await mh.measureHost(HW);
    const testUrl = mh.testUrlFor(HW);
    assert.equal(mh.segBusy(Date.now() + 5000), false, "the test does not count as the player fetching");
    poCallback({ getEntries: () => [{ name: testUrl, transferSize: 9e6, duration: 50 }] });
    mh.updateSpeed();
    assert.equal(mh.debug.currentCdn, before, "not logged as the player switching to HW");
    assert.equal(mh.debug.speedBps || 0, 0, "not a line sample");
    poCallback({ getEntries: () => [{ name: `https://${HOST}/upgcxcode/1/2/3/v80.m4s?x=1`, transferSize: 1e6, duration: 500 }] });
    assert.equal(mh.debug.currentCdn, HOST, "a real player segment still is");
    env.close();
  });
  test("the same video's playurl again (player reload) keeps the user's stop", () => {
    const { env, mh } = bootRescue({});
    mh.FALLBACK.userStopped = true;
    mh.rewriteRoot(playurl({}, 800000), "playurl");
    assert.equal(mh.FALLBACK.userStopped, true);
    env.close();
  });
});

describe("stall detection", () => {
  test("paused with an empty buffer and only a trickle of data still counts as stuck", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 1, currentTime: 10 });
    mh.addSample(2048, 1000, true); // 2 kB/s
    mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.notEqual(mh.stallState.stuckSince, null);
    assert.equal(mh.stallState.limit, 15000);
    env.close();
  });
  test("no media data at all (readyState 0) with only a trickle still counts as stuck", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 0, currentTime: 0 });
    mh.addSample(2048, 1000, true);
    mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.notEqual(mh.stallState.stuckSince, null);
    assert.equal(mh.stallState.limit, 20000);
    env.close();
  });
  test("readyState 0 while a normal-speed load is under way is not a stall", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 0, currentTime: 0 });
    mh.addSample(1024 * 1024, 500, true);
    mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.equal(mh.stallState.stuckSince, null);
    env.close();
  });
  test("the player paused itself on an empty buffer while data still comes in → counts, like a stall while playing (#41)", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 1, currentTime: 10 });
    mh.addSample(2 * 1024 * 1024, 1000, true);
    mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.notEqual(mh.stallState.stuckSince, null);
    assert.equal(mh.stallState.limit, 15000);
    env.close();
  });
  // 先走針一次（記下 movedAt），之後的 checkStall 就是「停住」
  function frozeNow(mh) { mh.checkStall(); }
  test("playing but frozen: 5 seconds is a stall even while data still comes in, counted from the last time it moved", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, readyState: 2, currentTime: 10 });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.addSample(2 * 1024 * 1024, 1000, true); // 還有資料在進來
    mh.updateSpeed();
    frozeNow(mh); // 走針（第一次看到）
    mh.stallState.movedAt -= 900; // 最後一次走針在 0.9 秒前（每秒才檢查一次）
    const movedAt = mh.stallState.movedAt;
    mh.checkStall(); // 這次才發現停住
    assert.equal(mh.stallState.limit, 5000);
    assert.equal(mh.stallState.stuckSince, movedAt, "counted from the last tick it was still moving, not from now");
    assert.ok(mh.stallState.stuckSince <= Date.now() - 800);
    mh.stallState.stuckSince = Date.now() - 4900;
    mh.checkStall();
    assert.equal(mh.isFailed(HOST), false, "4.9 s is not yet");
    mh.stallState.stuckSince = Date.now() - 5100;
    mh.checkStall();
    assert.equal(mh.isFailed(HOST), true, "5.1 s → rescue");
    env.close();
  });
  test("the player paused itself and no data comes in → stall after 8 seconds", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: true, readyState: 1, currentTime: 10 });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    frozeNow(mh); mh.checkStall();
    assert.equal(mh.stallState.limit, 8000);
    mh.stallState.stuckSince = Date.now() - 7900; mh.checkStall();
    assert.equal(mh.isFailed(HOST), false);
    mh.stallState.stuckSince = Date.now() - 8100; mh.checkStall();
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
  test("the player paused itself while data still comes in → stall after 15 seconds, not at 9", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: true, readyState: 1, currentTime: 10 });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.addSample(2 * 1024 * 1024, 1000, true); mh.updateSpeed();
    frozeNow(mh); mh.checkStall();
    mh.stallState.stuckSince = Date.now() - 9000; mh.checkStall();
    assert.equal(mh.isFailed(HOST), false, "9 s with data still arriving");
    mh.addSample(2 * 1024 * 1024, 1000, true);
    mh.stallState.stuckSince = Date.now() - 15100; mh.checkStall();
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
  test("a user pause (buffer ahead) never counts, however long", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: true, readyState: 4, currentTime: 10, buffered: [0, 30] });
    mh.FALLBACK.holdUntil = 0;
    for (let i = 0; i < 3; i++) mh.checkStall();
    assert.equal(mh.stallState.stuckSince, null);
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("an ended video is not a stall", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, ended: true, readyState: 4, currentTime: 600 });
    for (let i = 0; i < 3; i++) mh.checkStall();
    assert.equal(mh.stallState.stuckSince, null);
    env.close();
  });
  test("paused before it ever played (autoplay blocked, resuming from history) is not a stall", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 1, currentTime: 120, played: false });
    mh.checkStall(); mh.checkStall();
    assert.equal(mh.stallState.stuckSince, null);
    env.close();
  });
  test("live: paused while refilling at a real speed is still not a stall (unchanged)", () => {
    const env = boot({ liveRoute: "cn" }, "https://live.bilibili.com/12345");
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, readyState: 1, currentTime: 10 });
    mh.addSample(2 * 1024 * 1024, 1000, true);
    mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.equal(mh.stallState.stuckSince, null);
    env.close();
  });
  test("live: playing but frozen while data comes in → 20 s (not the 5 s of video pages); paused with only a trickle still counts", () => {
    const env = boot({ liveRoute: "cn" }, "https://live.bilibili.com/12345");
    const mh = env.internals("main-hook");
    addVideo(env, { paused: false, readyState: 2, currentTime: 10 });
    mh.addSample(2 * 1024 * 1024, 1000, true); mh.updateSpeed();
    mh.checkStall(); mh.checkStall();
    assert.equal(mh.stallState.limit, 20000);
    env.close();
    // 另開一個：速度是 10 秒窗口的平均，前面那筆快的樣本還在窗口裡就不算細水長流
    const env2 = boot({ liveRoute: "cn" }, "https://live.bilibili.com/12345");
    const m2 = env2.internals("main-hook");
    addVideo(env2, { paused: true, readyState: 1, currentTime: 10 });
    m2.addSample(2048, 1000, true); m2.updateSpeed(); // 2 kB/s
    m2.checkStall(); m2.checkStall();
    assert.notEqual(m2.stallState.stuckSince, null, "paused with only a trickle still counts");
    env2.close();
  });
  test("live / first load: segment requests keep going out but no data ever arrives → 8 s", () => {
    const env = boot({ liveRoute: "cn" }, "https://live.bilibili.com/12345");
    const mh = env.internals("main-hook");
    addVideo(env, { paused: false, readyState: 0, currentTime: 0, played: false });
    mh.setLastSegReqAt(Date.now());
    mh.checkStall(); mh.checkStall();
    assert.notEqual(mh.stallState.stuckSince, null);
    assert.equal(mh.stallState.limit, 8000);
    env.close();
  });
  test("30 s of smooth playback resets the 'all failed' question", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    const v = addVideo(env, { paused: false, readyState: 4, currentTime: 10, buffered: [0, 60] });
    mh.FALLBACK.asked = true;
    mh.checkStall();
    setVideo(v, { currentTime: 11 }); mh.checkStall(); // 開始順播
    mh.setProgressSince(Date.now() - 31000);
    setVideo(v, { currentTime: 12 }); mh.checkStall();
    assert.equal(mh.FALLBACK.asked, false);
    env.close();
  });
});

describe("node change in other tabs", () => {
  // 假的 player.reload：記錄有沒有被呼叫（有 player API 時換節點走播放器內重載）
  function spyPlayer(env) {
    const calls = [];
    env.window.player = { reload: () => calls.push("reload"), getCurrentTime: () => 0, seek() {} };
    return calls;
  }
  test("a paused tab picks the new node up without reloading the player", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    const calls = spyPlayer(env);
    addVideo(env, { paused: true, buffered: [0, 30] }); // 使用者自己按的暫停：前方還有緩衝
    assert.equal(mh.mainVideoIdle(), true);
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(mh.effHost(), COS, "later segment requests go to the new node");
    assert.deepEqual(calls, [], "no reload");
    env.close();
  });
  test("a non-watch page with a preview video is not reloaded; a playing watch page is", () => {
    const env = boot({}, "https://www.bilibili.com/");
    const calls = spyPlayer(env);
    addVideo(env, { paused: false });
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(env.internals("main-hook").effHost(), COS);
    assert.deepEqual(calls, [], "home page preview: no reload");
    env.close();
    const env2 = boot({});
    const calls2 = spyPlayer(env2);
    addVideo(env2, { paused: false, buffered: [0, 30] });
    env2.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.deepEqual(calls2, ["reload"], "watch page, playing: reload");
    env2.close();
  });
  test("an ended tab is idle (no reload)", () => {
    const env = boot({});
    const calls = spyPlayer(env);
    addVideo(env, { paused: true, ended: true, currentTime: 600 });
    assert.equal(env.internals("main-hook").mainVideoIdle(), true);
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.deepEqual(calls, []);
    env.close();
  });
});

describe("node change on a stalled tab (#41)", () => {
  test("the player paused itself on an empty buffer → not idle: the new node is applied with a reload", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, currentTime: 168 }); // 播過、前方沒有緩衝
    assert.equal(mh.mainVideoIdle(), false);
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.ok(env.window.sessionStorage.getItem("__CDN_SWITCHER_SWITCH_TOAST__").includes(COS), "a reload was queued");
    env.close();
  });
  test("never played yet → still idle (no reload that would start playback, #33)", () => {
    const env = boot({});
    const mh = env.internals("main-hook");
    addVideo(env, { paused: true, currentTime: 120, played: false });
    assert.equal(mh.mainVideoIdle(), true);
    env.close();
  });
  test("a node change clears the old node's stall timer, rebuffer count and deferred failure, and gives the new node a grace period", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, currentTime: 10, buffered: [0, 30] });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.setLastSegReqAt(Date.now()); // 已經在抓分段（換掉的是正在用的節點）
    mh.stallState.stuckSince = Date.now() - 7000;
    mh.health.rebuf.push(Date.now());
    mh.onSegFailure("network-error"); // 緩衝夠 → 暫緩
    assert.equal(mh.segFail.reason, "network-error");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } });
    assert.equal(mh.stallState.stuckSince, null);
    assert.equal(mh.health.rebuf.length, 0);
    assert.equal(mh.segFail.reason, null, "the deferred failure belonged to the old node");
    assert.equal(mh.maybeFallback("stalled"), false, "within the grace period");
    mh.FALLBACK.holdUntil -= 9000; // 9 秒：還在寬限內
    assert.equal(mh.maybeFallback("stalled"), false);
    mh.FALLBACK.holdUntil -= 1100; // 過了 10 秒
    assert.equal(mh.maybeFallback("stalled"), true);
    env.close();
  });
  test("the first config push on page load (nothing fetched yet) gives no grace: a dead first node is rescued right away", () => {
    const env = boot({ autoSpeedHosts: [] });
    const mh = env.internals("main-hook");
    speedFetch(env, {});
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: COS } }); // bridge 第一次推設定
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: false, currentTime: 0, readyState: 0, played: false });
    assert.ok(mh.FALLBACK.holdUntil <= Date.now(), "no grace");
    mh.onSegFailure("network-error");
    assert.equal(mh.isFailed(COS), true, "rescued on the first failure");
    env.close();
  });
  test("a node picked by the rescue reloads this tab even if it never started playing", async () => {
    const HW = "upos-sz-mirrorhw.bilivideo.com";
    const env = boot({ autoSpeedHosts: [HOST, HW] });
    const mh = env.internals("main-hook");
    const calls = [];
    env.window.player = { reload: () => calls.push("reload"), getCurrentTime: () => 0, seek() {} };
    speedFetch(env, { [HW]: "fast" });
    const posted = capturePosts(env);
    mh.rewriteRoot(playurl(), "playurl");
    addVideo(env, { paused: true, currentTime: 0, readyState: 0, played: false }); // 開頭就卡住、播放器自己暫停
    mh.FALLBACK.holdUntil = 0;
    mh.maybeFallback("network-error");
    for (let i = 0; i < 300 && !posted.some((m) => m.dir === "autotest-done"); i++) await env.settle(10);
    const done = posted.find((m) => m.dir === "autotest-done");
    assert.ok(done, "the rescue picked HW");
    env.postMessage({ __cdnSwitcher: 1, dir: "config", payload: { cdnHost: HW } }); // bridge 寫完設定推回來
    assert.deepEqual(calls, ["reload"], "reloaded although the tab looks idle (never played)");
    env.close();
  });
});

describe("rebuffer counting and stall prediction", () => {
  // 一個播放中的影片頁；health 的安靜期清掉、上一秒的播放時間設好，checkHealth 就從「下一秒」開始看
  function bootHealth(video, cfg = {}) {
    const env = boot({ autoSpeedHosts: [], ...cfg });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    const v = addVideo(env, { paused: false, currentTime: 10, buffered: [0, 30], ...video });
    speedFetch(env, {});
    mh.FALLBACK.holdUntil = 0;
    mh.checkHealth(); // 記下畫質
    mh.health.quietUntil = 0;
    return { env, mh, v };
  }
  // 畫面停住一次（停住超過 REBUF_MIN_MS），再走針
  function freezeOnce(mh, v, ct, props = {}) {
    setVideo(v, { currentTime: ct, ...props });
    mh.health.lastT = ct;
    mh.checkHealth(); // 第一次看到停住
    mh.health.freezeAt -= 2000;
    mh.checkHealth(); // 停超過 1.5 秒 → 算一次
    setVideo(v, { currentTime: ct + 1, paused: false, buffered: [0, ct + 5] });
    mh.checkHealth(); // 恢復走針
  }
  test("the second rebuffer within two minutes triggers the fallback", () => {
    const { env, mh, v } = bootHealth({});
    freezeOnce(mh, v, 20, { buffered: [0, 20.2] });
    assert.equal(mh.health.rebuf.length, 1);
    assert.equal(mh.isFailed(HOST), false, "one short stall is not enough");
    freezeOnce(mh, v, 40, { paused: true, buffered: [0, 40.2] }); // 第二次：播放器自己暫停的那種
    assert.equal(mh.isFailed(HOST), true, "rescue started");
    env.close();
  });
  test("not a rebuffer: frozen with buffer ahead, a user pause (even with < 1 s ahead), a seek, never played", () => {
    const { env, mh, v } = bootHealth({});
    freezeOnce(mh, v, 20, { buffered: [0, 25] });
    freezeOnce(mh, v, 40, { paused: true, buffered: [0, 40.7] }); // 使用者暫停，前方只剩 0.7 秒（< 1 秒門檻，但還算「有前方緩衝」）
    freezeOnce(mh, v, 70, { seeking: true, buffered: [70, 70] });
    freezeOnce(mh, v, 90, { played: false, buffered: [0, 90.2] });
    assert.equal(mh.health.rebuf.length, 0);
    env.close();
  });
  test("one freeze counts once however long it lasts; 1.4 s is not a rebuffer", () => {
    const { env, mh, v } = bootHealth({});
    setVideo(v, { currentTime: 20, buffered: [0, 20.2] });
    mh.health.lastT = 20;
    mh.checkHealth(); mh.health.freezeAt -= 1400; mh.checkHealth();
    assert.equal(mh.health.rebuf.length, 0, "1.4 s");
    mh.health.freezeAt -= 200; mh.checkHealth();
    assert.equal(mh.health.rebuf.length, 1, "1.6 s");
    for (let i = 0; i < 5; i++) { mh.health.freezeAt -= 1000; mh.checkHealth(); }
    assert.equal(mh.health.rebuf.length, 1, "still the same freeze");
    env.close();
  });
  test("the 2-minute window: an older rebuffer does not count", () => {
    const { env, mh, v } = bootHealth({});
    mh.health.rebuf.push(Date.now() - 121000);
    freezeOnce(mh, v, 20, { buffered: [0, 20.2] });
    assert.equal(mh.health.rebuf.length, 1);
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("a blocked trigger keeps the count; a successful one clears it", () => {
    const { env, mh, v } = bootHealth({});
    mh.FALLBACK.holdUntil = Date.now() + 60000; // 寬限中
    freezeOnce(mh, v, 20, { buffered: [0, 20.2] });
    freezeOnce(mh, v, 40, { buffered: [0, 40.2] });
    assert.equal(mh.health.rebuf.length, 2, "blocked → kept");
    assert.equal(mh.isFailed(HOST), false);
    mh.FALLBACK.holdUntil = 0;
    freezeOnce(mh, v, 60, { buffered: [0, 60.2] });
    assert.equal(mh.isFailed(HOST), true);
    assert.equal(mh.health.rebuf.length, 0, "triggered → cleared");
    env.close();
  });
  test("quiet periods: seeking / emptied / loadstart events, a new video element, a quality change, a speed test", async () => {
    const { env, mh, v } = bootHealth({});
    mh.trackVideoEvents();
    for (const ev of ["seeking", "emptied", "loadstart"]) {
      mh.health.quietUntil = 0;
      v.dispatchEvent(new env.window.Event(ev));
      assert.ok(mh.health.quietUntil > Date.now() + 5000, ev);
      freezeOnce(mh, v, 20, { buffered: [0, 20.2] }); // 安靜期內停住
      assert.equal(mh.health.rebuf.length, 0, ev + ": not counted during the quiet period");
    }
    mh.health.quietUntil = 0;
    const v2 = addVideo(env, { paused: false, currentTime: 0, buffered: [0, 5] });
    v.remove();
    mh.trackVideoEvents();
    assert.ok(mh.health.quietUntil > Date.now(), "new video element");
    mh.health.quietUntil = 0;
    mh.debug.lastQn = 64; // 切畫質
    mh.checkHealth();
    assert.ok(mh.health.quietUntil > Date.now(), "quality change");
    mh.health.quietUntil = 0;
    speedFetch(env, { [HOST]: 1000 });
    mh.runSpeedTest([HOST], {});
    mh.checkHealth(); // 測速中
    assert.ok(mh.health.quietUntil > Date.now(), "during a speed test");
    mh.health.quietUntil = 0;
    for (let i = 0; i < 100 && mh.health.quietUntil === 0; i++) await env.settle(10);
    assert.ok(mh.health.quietUntil > Date.now(), "after the speed test");
    void v2;
    env.close();
  });
  test("bufSlope uses the regression, not the two end points (sawtooth of segments arriving in batches)", () => {
    const { env, mh, v } = bootHealth({});
    const now = Date.now();
    const h = [9, 8, 10, 9, 8, 7, 9, 8, 7, 6].map((buf, i) => ({ at: now - (9 - i) * 1000, buf }));
    const slope = mh.bufSlope(h);
    assert.ok(slope > -0.3 && slope < -0.25, `regression ≈ -0.273 (end points would give -0.333): ${slope}`);
    assert.equal(mh.bufSlope([{ at: 0, buf: 1 }]), 0);
    mh.health.hist = h;
    setVideo(v, { currentTime: 100, duration: 600 });
    assert.equal(mh.predictStall(v, 6, now), null, "the end-point slope would have triggered");
    env.close();
  });
  // 播放「一頓一頓」：每秒只前進 adv 秒、前方緩衝 buf 秒，跑 n 個 tick
  function stutter(mh, v, n, { adv = 0.7, buf = 0.5, paused = false } = {}) {
    let ct = 100;
    mh.health.lastT = ct;
    for (let i = 0; i < n; i++) {
      mh.health.lastAt = Date.now() - 1000;
      ct += adv;
      setVideo(v, { currentTime: ct, paused, buffered: [0, ct + buf] });
      mh.checkHealth();
    }
  }
  test("stutter: micro-stalls that never last 1.5 s (0.7× speed, buffer stuck below 1 s) trigger once 5 s of lag piles up within 30 s", () => {
    const { env, mh, v } = bootHealth({});
    stutter(mh, v, 15); // 落後 15 × 0.3 = 4.5 秒
    assert.equal(mh.isFailed(HOST), false);
    assert.equal(mh.health.rebuf.length, 0, "no single freeze long enough to be a rebuffer");
    stutter(mh, v, 3); // 再 0.9 秒 → 超過 5 秒
    assert.equal(mh.isFailed(HOST), true, "rescue started");
    env.close();
  });
  test("stutter: no false alarm for timer jitter, healthy low-buffer playback, or lag with plenty of buffer", () => {
    const { env, mh, v } = bootHealth({});
    stutter(mh, v, 60, { adv: 0.9, buf: 0.5 }); // 每秒 0.1 秒的誤差（低於 0.15 秒雜訊門檻）
    stutter(mh, v, 60, { adv: 1, buf: 8 }); // 4K 小緩衝、正常播放
    stutter(mh, v, 60, { adv: 0.5, buf: 5 }); // 落後但緩衝還有 5 秒（不是線路問題）
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("stutter: lag older than 30 s drops out", () => {
    const { env, mh, v } = bootHealth({});
    stutter(mh, v, 15);
    for (const x of mh.health.lag) x.at -= 31000;
    stutter(mh, v, 3);
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("a pause that happens with < 0.5 s ahead is the player's own buffering pause: not a user pause even after the buffer grows back", () => {
    const { env, mh, v } = bootHealth({ currentTime: 10, buffered: [0, 10.2] });
    mh.trackVideoEvents();
    setVideo(v, { paused: true });
    v.dispatchEvent(new env.window.Event("pause")); // 緩衝只剩 0.2 秒時暫停
    assert.equal(mh.health.bufPause, true);
    setVideo(v, { buffered: [0, 14] }); // 攢回 4 秒
    assert.equal(mh.mainVideoIdle(), false, "a node change would reload it");
    mh.checkStall(); mh.checkStall();
    assert.notEqual(mh.stallState.stuckSince, null, "counts as stuck");
    v.dispatchEvent(new env.window.Event("play"));
    assert.equal(mh.health.bufPause, false);
    // 對照：使用者在有緩衝時按暫停
    setVideo(v, { paused: true, buffered: [0, 40] });
    v.dispatchEvent(new env.window.Event("pause"));
    assert.equal(mh.health.bufPause, false);
    assert.equal(mh.mainVideoIdle(), true);
    env.close();
  });
  test("buffering pauses (pause to collect a few seconds, then play) pile up as lag and trigger", () => {
    const { env, mh, v } = bootHealth({});
    mh.health.bufPause = true;
    stutter(mh, v, 6, { adv: 0, buf: 3, paused: true }); // 停著攢緩衝 6 秒（緩衝 3 秒，照理不算，但這是緩衝暫停）
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
  test("rescue speed test gives up early: no headers within the TTFB limit, or far below the needed speed", async () => {
    const env = boot({ autoSpeedHosts: [HOST] });
    const mh = env.internals("main-hook");
    mh.rewriteRoot(playurl(), "playurl");
    env.fetchHandler = () => new Promise(() => {}); // 連 header 都不回
    let t = Date.now();
    let r = await mh.measureHost(COS, { ttfbMs: 80 });
    assert.equal(r.error, "slow-ttfb");
    assert.ok(Date.now() - t < 1000);
    // 細水長流：每 20 ms 給 100 bytes
    env.fetchHandler = () => ({ ok: true, status: 200, body: { getReader: () => ({ cancel() {},
      read: () => new Promise((res) => setTimeout(() => res({ done: false, value: { length: 100 } }), 20)) }) } });
    t = Date.now();
    r = await mh.measureHost(COS, { minBps: 1e6, checkMs: 150 });
    assert.equal(r.error, "too-slow");
    assert.ok(Date.now() - t < 1000);
    env.close();
  });
  test("prediction thresholds: span ≥ 6 s, ≥ 4 samples, slope ≤ -0.3, empty within 20 s, buffer < 10 s", () => {
    const { env, mh, v } = bootHealth({});
    setVideo(v, { currentTime: 100, duration: 600 });
    const now = Date.now();
    // n 筆、每 step 毫秒一筆、緩衝從 from 等速掉到 to
    const hist = (n, step, from, to) => Array.from({ length: n }, (_, i) => ({ at: now - (n - 1 - i) * step, buf: from + (to - from) * i / (n - 1) }));
    const p = (h, buf) => { mh.health.hist = h; return mh.predictStall(v, buf, now); };
    assert.ok(p(hist(8, 1000, 9, 4), 4), "baseline triggers");
    assert.equal(p(hist(6, 1000, 9, 6), 6), null, "span 5 s < 6 s");
    assert.equal(p(hist(3, 3500, 9, 4), 4), null, "only 3 samples");
    assert.equal(p(hist(8, 1000, 6, 6 - 0.29 * 7), 4), null, "slope -0.29");
    assert.equal(p(hist(8, 1000, 9.9, 9.9 - 0.4 * 7), 9.5), null, "9.5 s at -0.4/s = 23.75 s left > 20 s");
    assert.equal(p(hist(8, 1000, 15, 10), 10), null, "buffer exactly 10 s");
    env.close();
  });
  // 播放器一直在抓分段，前方緩衝從 from 一路變到 to（每秒一筆），最後這一秒播到 ct
  function drain(mh, v, from, to, { busy = true, ct = 100, duration = 600 } = {}) {
    const now = Date.now(), n = 8;
    mh.health.hist = [];
    for (let i = 0; i < n; i++) mh.health.hist.push({ at: now - (n - i) * 1000, buf: from + (to - from) * i / (n - 1) });
    if (busy) mh.segReqStart();
    setVideo(v, { currentTime: ct, buffered: [0, ct + to], duration });
    mh.health.lastT = ct - 1;
    mh.checkHealth();
    if (busy) mh.segReqEnd();
  }
  test("buffer keeps falling while the player is fetching → rescue before the stall", () => {
    const { env, mh, v } = bootHealth({});
    drain(mh, v, 9, 4);
    assert.equal(mh.isFailed(HOST), true);
    env.close();
  });
  test("no false alarms: refilling, idle drain, plenty of buffer, end of video", () => {
    const { env, mh, v } = bootHealth({});
    drain(mh, v, 9, 4, { busy: false }); // 沒在抓：緩衝自然下降（抓滿後停抓）。放第一個：剛結束的請求在 2 秒內還算「在抓」
    drain(mh, v, 3, 8); // 抓得到：緩衝回升
    drain(mh, v, 30, 12); // 緩衝還很多
    drain(mh, v, 9, 4, { ct: 595, duration: 600 }); // 已經緩衝到片尾
    assert.equal(mh.isFailed(HOST), false);
    env.close();
  });
  test("a prediction never pops the 'all failed' question; a real stall still does", () => {
    const { env, mh, v } = bootHealth({});
    mh.markFailed(COS); mh.markFailed(ALI); // 候選都試過了
    drain(mh, v, 9, 4);
    assert.equal(mh.isFailed(HOST), true, "the prediction still marks the current node");
    assert.equal(mh.FALLBACK.asked, false, "but does not ask");
    assert.equal(mh.maybeFallback("rebuffer"), true);
    assert.equal(mh.FALLBACK.asked, true);
    env.close();
  });
});

describe("install test (first video after a fresh install)", () => {
  const SAMPLE = `https://${HOST}/upgcxcode/1/2/3/v80.m4s?deadline=${FUTURE}`;
  // speeds: host → "fast" (8 MB at once ≥ 25 Mbps) | bytes delivered over ~30 ms (well below 25 Mbps) | "403"
  function run(speeds, hosts, cfg = {}) {
    const env = boot({ installTestPending: true, autoSpeedHosts: hosts, ...cfg });
    const posted = [], asked = [];
    env.window.postMessage = (m) => { if (m && m.__cdnSwitcher === 1) posted.push(m); };
    env.fetchHandler = (url) => {
      const host = new URL(url).host;
      asked.push(host);
      const sp = speeds[host];
      if (sp === "403") return { ok: false, status: 403 };
      let sent = false;
      return { ok: true, status: 206, body: { getReader: () => ({
        cancel() {},
        read: () => sent ? Promise.resolve({ done: true })
          // 「fast」也要過幾毫秒：同一毫秒內讀完的話 measureHost 算出的 ms = 0、速度會記成 0
          : sp === "fast" ? new Promise((r) => setTimeout(() => { sent = true; r({ done: false, value: { length: 9e6 } }); }, 5))
          : new Promise((r) => setTimeout(() => { sent = true; r({ done: false, value: { length: sp } }); }, 30))
      }) } };
    };
    const mh = env.internals("main-hook");
    mh.noteEarlySample(SAMPLE);
    mh.runAutoSpeedTest(hosts, "install");
    return { env, posted, asked, mh };
  }
  const of = (posted, dir) => posted.filter((m) => m.dir === dir).map((m) => m.payload);
  // 等這一輪結束（autotest-end），不用固定秒數：整套測試一起跑時計時器會被拖慢
  async function ended(env, posted) {
    for (let i = 0; i < 200 && !of(posted, "autotest-end").length; i++) await env.settle(10);
  }

  test("default already plays 4K → stays, nothing else is tested even if another node would be faster", async () => {
    const { env, posted, asked, mh } = run({ [HOST]: "fast", [COS]: "fast" }, [HOST, COS, ALI]);
    await ended(env, posted);
    assert.deepEqual(asked, [HOST]);
    assert.deepEqual(of(posted, "autotest-done"), []);
    assert.equal(of(posted, "autotest-start")[0].total, 3);
    assert.equal(of(posted, "autotest-start")[0].maxMs, 3 * 5000 + 5000, "every node at most stVideoSec, plus slack");
    assert.equal(of(posted, "autotest-end").length, 1);
    assert.equal(mh.cfg().installTestPending, false, "one-shot");
    env.close();
  });
  test("default too slow → the first node that reaches 4K wins and the rest are skipped", async () => {
    const { env, posted, asked } = run({ [HOST]: 1000, [COS]: "fast", [ALI]: "fast" }, [COS, HOST, ALI]);
    await ended(env, posted);
    assert.deepEqual(asked, [HOST, COS], "the current node first, then the list in order");
    assert.deepEqual(plain(of(posted, "autotest-done")), [{ host: COS, from: HOST, reason: "install" }]);
    env.close();
  });
  test("nothing reaches 4K → the fastest one after testing them all", async () => {
    const { env, posted, asked } = run({ [HOST]: 1000, [COS]: "403", [ALI]: 20000 }, [HOST, COS, ALI]);
    await ended(env, posted);
    assert.deepEqual(asked, [HOST, COS, ALI]);
    assert.deepEqual(plain(of(posted, "autotest-done")), [{ host: ALI, from: HOST, reason: "install" }]);
    env.close();
  });
  test("nothing reaches 4K and the default is still the fastest → no switch", async () => {
    const { env, posted } = run({ [HOST]: 20000, [COS]: 1000, [ALI]: "403" }, [HOST, COS, ALI]);
    await ended(env, posted);
    assert.deepEqual(of(posted, "autotest-done"), []);
    assert.equal(of(posted, "autotest-end").length, 1);
    env.close();
  });
  test("not armed → does not run", async () => {
    const { env, asked } = run({ [HOST]: "fast" }, [HOST, COS], { installTestPending: false });
    await env.settle(30);
    assert.deepEqual(asked, []);
    env.close();
  });
});
