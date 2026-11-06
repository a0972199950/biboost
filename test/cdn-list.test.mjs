// src/cdn-list.js（節點清單由伺服器下發）：驗章、白名單、快取與「沒更新就不下載」、主要／備援來源
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, plain, closeAll, testKey, CDN_FIXTURE, signCdnList, cdnListStorage } from "./helpers/load.mjs";
import { signJws } from "../tools/report-worker/src/features.js";

after(closeAll);
const clone = (x) => JSON.parse(JSON.stringify(x));
const [PRIMARY, BACKUP] = ["https://static.biboost.app/", "https://dv1itfovv5waq.cloudfront.net/"];

// sources：{ <base>: { v, jws } | "down" }，沒列的來源＝連不上
function boot({ storage = {}, cdnList, sources = {} } = {}) {
  const env = createEnv({ storage, cdnList });
  env.fetchHandler = (url) => {
    for (const [base, src] of Object.entries(sources)) {
      if (!url.startsWith(base) || src === "down") continue;
      if (url === base + "cdn-list/latest.json") return { ok: true, status: 200, json: () => Promise.resolve({ v: src.v, file: `cdn-list/v/${src.v}.jws` }) };
      if (url === base + `cdn-list/v/${src.v}.jws`) return { ok: true, status: 200, text: () => Promise.resolve(src.jws) };
      return { ok: false, status: 404 };
    }
    throw new TypeError("Failed to fetch");
  };
  env.load("cdn-list.js");
  return { env, L: env.internals("cdn-list") };
}
const listCalls = (env) => env.fetchCalls.filter((c) => /cdn-list\//.test(c.url)).map((c) => c.url);

describe("validate", () => {
  const { env, L } = boot();
  after(() => env.close());
  test("the fixture passes", () => assert.deepEqual(plain(L.validate(CDN_FIXTURE)), []));
  test("a node outside the CDN domains rejects the whole list", () => {
    const d = clone(CDN_FIXTURE);
    d.options.unshift({ value: "evil.example.com", name: "x" });
    d.countries[0].nodes.unshift("evil.example.com");
    const errs = L.validate(d);
    assert.ok(errs.some((e) => e.includes("evil.example.com")));
  });
  test("lookalike domains are rejected", () => {
    for (const h of ["bilivideo.com.evil.net", "x.bilivideo.com.", "xbilivideo.com", "x.bilivideo.com/path", "X.BILIVIDEO.COM"]) assert.equal(L.isHost(h), false, h);
    for (const h of ["upos-sz-mirror08c.bilivideo.com", "upos-hz-mirrorakam.akamaized.net", "d1--cn-gotcha01.bilivideo.cn"]) assert.equal(L.isHost(h), true, h);
  });
  test("country nodes must be in options; OTHER is required", () => {
    const d = clone(CDN_FIXTURE);
    d.countries[0].nodes.push("not-in-options.bilivideo.com");
    assert.ok(L.validate(d).some((e) => e.includes("不在 options")));
    const d2 = clone(CDN_FIXTURE);
    d2.countries = d2.countries.filter((c) => c.code !== "OTHER");
    assert.ok(L.validate(d2).some((e) => e.includes("OTHER")));
    assert.ok(L.validate(null).length);
    assert.ok(L.validate({ countries: [], options: [] }).length);
  });
  test("defaultHost = OTHER's first node; countryHosts keeps known hosts only", () => {
    assert.equal(L.defaultHost(CDN_FIXTURE), CDN_FIXTURE.countries.find((c) => c.code === "OTHER").nodes[0]);
    assert.deepEqual(plain(L.countryHosts(CDN_FIXTURE, "SG")), CDN_FIXTURE.countries.find((c) => c.code === "SG").nodes);
    assert.deepEqual(plain(L.countryHosts(CDN_FIXTURE, "XX")), []);
  });
});

describe("load (local cache, re-verified on every read)", () => {
  test("a stored signed list loads", async () => {
    const { env, L } = boot();
    const r = await L.load();
    assert.equal(r.v, 1);
    assert.equal(r.data.countries.length, CDN_FIXTURE.countries.length);
    env.close();
  });
  test("nothing stored → null", async () => {
    const { env, L } = boot({ cdnList: false });
    assert.equal(await L.load(), null);
    env.close();
  });
  test("tampered payload, wrong key, wrong typ or a version mismatch → null", async () => {
    const good = await signCdnList();
    const [h, p, s] = good.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.data.countries[0].nodes[0] = "test-extra-01.bilivideo.com";
    const tampered = [h, Buffer.from(JSON.stringify(payload)).toString("base64url"), s].join(".");
    const other = await testKey();
    const foreign = await signJws({ typ: "cdn-list", v: 1, iat: 1, data: CDN_FIXTURE }, other.priv, "t1");
    const featuresJws = await signCdnList(CDN_FIXTURE, 1, { typ: undefined, features: {} });
    for (const [jws, v] of [[tampered, 1], [foreign, 1], [featuresJws, 1], [good, 2]]) {
      const { env, L } = boot({ storage: { cdnList: { v, jws } } });
      assert.equal(await L.load(), null);
      env.close();
    }
  });
  test("a signed list with a domain outside the allowlist is not used either", async () => {
    const d = clone(CDN_FIXTURE);
    d.options.unshift({ value: "evil.example.com", name: "x" });
    const { env, L } = boot({ storage: cdnListStorage({ jws: await signCdnList(d) }) });
    assert.equal(await L.load(), null);
    env.close();
  });
});

describe("refresh", () => {
  test("checked within 6 hours → no request at all", async () => {
    const { env, L } = boot();
    const r = await L.refresh(false);
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.deepEqual(listCalls(env), []);
    env.close();
  });
  test("past 6 hours, same version → only latest.json; cache untouched, checkedAt updated", async () => {
    const before = cdnListStorage({ checkedAt: Date.now() - 7 * 3600e3 });
    const { env, L } = boot({ storage: before, sources: { [PRIMARY]: { v: 1, jws: "unused" } } });
    const r = await L.refresh(false);
    assert.equal(r.changed, false);
    assert.deepEqual(listCalls(env), [PRIMARY + "cdn-list/latest.json"]);
    assert.deepEqual(env.storage.cdnList, before.cdnList);
    assert.ok(env.storage.cdnListMeta.checkedAt > before.cdnListMeta.checkedAt);
    env.close();
  });
  test("new version → downloads, verifies and replaces the cache; meta carries the new default", async () => {
    const d = clone(CDN_FIXTURE);
    d.countries.find((c) => c.code === "OTHER").nodes.reverse();
    const jws = await signCdnList(d, 2);
    const { env, L } = boot({ storage: cdnListStorage({ checkedAt: 0 }), sources: { [PRIMARY]: { v: 2, jws } } });
    const r = await L.refresh(false);
    assert.equal(r.changed, true);
    assert.deepEqual(env.storage.cdnList, { v: 2, jws });
    assert.equal(env.storage.cdnListMeta.v, 2);
    assert.equal(env.storage.cdnListMeta.defaultHost, d.countries.find((c) => c.code === "OTHER").nodes[0]);
    assert.equal((await L.load()).v, 2);
    env.close();
  });
  test("primary down → backup", async () => {
    const jws = await signCdnList(CDN_FIXTURE, 3);
    const { env, L } = boot({ cdnList: false, sources: { [PRIMARY]: "down", [BACKUP]: { v: 3, jws } } });
    const r = await L.refresh(true);
    assert.equal(r.ok, true);
    assert.equal(env.storage.cdnList.v, 3);
    env.close();
  });
  test("primary serves a bad file → backup", async () => {
    const good = await signCdnList(CDN_FIXTURE, 4);
    const { env, L } = boot({ cdnList: false, sources: { [PRIMARY]: { v: 4, jws: good.slice(0, -4) + "AAAA" }, [BACKUP]: { v: 4, jws: good } } });
    assert.equal((await L.refresh(true)).ok, true);
    assert.equal(env.storage.cdnList.jws, good);
    env.close();
  });
  test("an older version from the server never replaces a newer local list", async () => {
    const { env, L } = boot({ storage: cdnListStorage({ jws: await signCdnList(CDN_FIXTURE, 5), v: 5, checkedAt: 0 }), sources: { [PRIMARY]: { v: 4, jws: await signCdnList(CDN_FIXTURE, 4) } } });
    const r = await L.refresh(false);
    assert.equal(r.changed, false);
    assert.equal(env.storage.cdnList.v, 5);
    env.close();
  });
  test("both down and nothing cached → not ok, nothing written", async () => {
    const { env, L } = boot({ cdnList: false });
    const r = await L.refresh(true);
    assert.equal(r.ok, false);
    assert.equal("cdnList" in env.storage, false);
    assert.equal("cdnListMeta" in env.storage, false);
    env.close();
  });
  test("both down with a cached list → still ok; retries in 30 minutes, not on every page", async () => {
    const { env, L } = boot({ storage: cdnListStorage({ checkedAt: 0 }) });
    const r = await L.refresh(false);
    assert.equal(r.ok, true);
    const wait = env.storage.cdnListMeta.checkedAt + L.CHECK_MS - Date.now();
    assert.ok(wait > 29 * 60e3 && wait <= 30 * 60e3, String(wait));
    env.close();
  });
});

describe("publishing tool (scripts/lib/cdn-list.mjs)", async () => {
  const lib = await import("../scripts/lib/cdn-list.mjs");
  test("uses the extension's own validation", () => {
    assert.deepEqual(lib.validate(CDN_FIXTURE), []);
    const d = clone(CDN_FIXTURE);
    d.options.push({ value: "evil.example.com" });
    assert.ok(lib.validate(d).some((e) => e.includes("evil.example.com")));
  });
  test("format round-trips and keeps one node per line", () => {
    const text = lib.format(CDN_FIXTURE);
    assert.deepEqual(JSON.parse(text), CDN_FIXTURE);
    assert.ok(text.includes('\n        "test-tw-01.bilivideo.com",\n'));
  });
  test("diff describes what users would notice", () => {
    const b = clone(CDN_FIXTURE);
    const tw = b.countries.find((c) => c.code === "TW");
    tw.nodes = [tw.nodes[1], tw.nodes[0], "test-extra-01.bilivideo.com"];
    b.countries.find((c) => c.code === "OTHER").nodes.reverse();
    b.countries = b.countries.filter((c) => c.code !== "RU");
    const lines = lib.diff(CDN_FIXTURE, b).join("\n");
    assert.match(lines, /TW（台灣）：預設 upos-sz-mirror08ct\.bilivideo\.com → test-tw-01\.bilivideo\.com；加入 test-extra-01\.bilivideo\.com；移除/);
    assert.match(lines, /－ 移除國家 RU/);
    assert.match(lines, /！ 全域預設/);
    assert.deepEqual(lib.diff(CDN_FIXTURE, clone(CDN_FIXTURE)), []);
  });
});
