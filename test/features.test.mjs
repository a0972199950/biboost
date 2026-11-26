// 功能開關：擴充的 src/features.js（驗章、快取、內頁 404）
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, closeAll, testKey, plain } from "./helpers/load.mjs";
import { signJws } from "../scripts/lib/jws.mjs";

describe("src/features.js（擴充）", () => {
  const API = "https://api.biboost.app/v1/features";
  let key, other;
  before(async () => { key = await testKey(); other = await testKey(); });

  // answer：fetch /v1/features 的回應內容（null＝連不上）
  function boot({ answer = null, storage = {}, html } = {}) {
    const env = createEnv({ storage, html });
    env.fetchHandler = (url) => {
      if (url === API && answer) return { ok: true, status: 200, json: () => Promise.resolve(answer) };
      throw new TypeError("Failed to fetch");
    };
    env.load("features.js");
    const fx = env.internals("features");
    fx.PUBLIC_KEYS.t1 = key.pub;
    return { env, fx };
  }
  const sign = (features, k = key, kid = "t1") => signJws({ iat: 100, features }, k.priv, kid);

  test("verifyJws: only a valid ES256 signature from a known kid", async () => {
    const { env, fx } = boot();
    const jws = await sign({ donate: { enabled: false } });
    const [h, p, s] = jws.split(".");
    assert.deepEqual(plain(await fx.verifyJws(jws, fx.PUBLIC_KEYS)).features, { donate: { enabled: false } });
    const forged = Buffer.from(JSON.stringify({ iat: 100, features: { donate: { enabled: true } } })).toString("base64url");
    assert.equal(await fx.verifyJws([h, forged, s].join("."), fx.PUBLIC_KEYS), null, "payload changed");
    assert.equal(await fx.verifyJws(await sign({}, other), fx.PUBLIC_KEYS), null, "someone else's key");
    assert.equal(await fx.verifyJws(await sign({}, key, "nope"), fx.PUBLIC_KEYS), null, "unknown kid");
    const none = Buffer.from(JSON.stringify({ alg: "none", kid: "t1" })).toString("base64url");
    assert.equal(await fx.verifyJws([none, p, ""].join("."), fx.PUBLIC_KEYS), null, "alg none");
    assert.equal(await fx.verifyJws("garbage", fx.PUBLIC_KEYS), null);
    assert.equal(await fx.verifyJws(null, fx.PUBLIC_KEYS), null);
    env.close();
  });

  test("refresh stores the signed answer; load re-verifies it every time", async () => {
    const { env, fx } = boot({ answer: { ok: true, jws: await sign({ donate: { enabled: false }, extra: { enabled: false, group: "x" } }) } });
    const flags = plain(await fx.refresh());
    assert.deepEqual(flags, { donate: { enabled: false }, cloud_sync: { enabled: false }, extra: { enabled: false, group: "x" } });
    assert.equal(env.storage.featureFlags.api, "https://api.biboost.app");
    assert.equal(fx.enabled(await fx.load(), "donate"), false);
    // 有人改了 storage 裡的 payload：驗不過 → 回到預設值
    const [h, , s] = env.storage.featureFlags.jws.split(".");
    env.storage.featureFlags.jws = [h, Buffer.from(JSON.stringify({ iat: 1, features: { donate: { enabled: true, group: "x" } } })).toString("base64url"), s].join(".");
    assert.deepEqual(plain(await fx.load()), { donate: { enabled: true }, cloud_sync: { enabled: false } });
    env.close();
  });

  test("a bad answer from the API is not stored; the last good one stays", async () => {
    const good = await sign({ donate: { enabled: false } });
    const { env, fx } = boot({ answer: { ok: true, jws: (await sign({ donate: { enabled: true } }, other)) }, storage: { featureFlags: { api: "https://api.biboost.app", jws: good } } });
    assert.equal(await fx.refresh(), null);
    assert.equal(env.storage.featureFlags.jws, good);
    assert.equal(fx.enabled(await fx.load(), "donate"), false);
    env.close();
  });

  test("watch: cached first, then the fresh answer only when it differs", async () => {
    const { env, fx } = boot({ answer: { ok: true, jws: await sign({ donate: { enabled: false } }) } });
    const seen = [];
    await fx.watch((f) => seen.push(fx.enabled(f, "donate")));
    assert.deepEqual(seen, [true, false]);
    env.close();
  });

  test("offline with no cache: defaults (everything on); unknown keys are on", async () => {
    const { env, fx } = boot();
    const flags = await fx.load();
    assert.equal(await fx.refresh(), null);
    assert.equal(fx.enabled(flags, "donate"), true);
    assert.equal(fx.enabled(flags, "not_a_feature"), true);
    env.close();
  });

  test("guardPage: a switched-off feature's own page becomes 'not found'", async () => {
    const html = "<!doctype html><html><head><title>Thing</title></head><body><div id=app>secret UI</div></body></html>";
    const off = boot({ html, answer: { ok: true, jws: await sign({ thing: { enabled: false } }) } });
    assert.equal(await off.fx.guardPage("thing"), false);
    assert.equal(off.env.document.getElementById("app"), null);
    assert.equal(off.env.document.title, "Page not found");
    assert.match(off.env.document.body.textContent, /not available/);
    off.env.close();
    const on = boot({ html, answer: { ok: true, jws: await sign({ thing: { enabled: true } }) } });
    assert.equal(await on.fx.guardPage("thing"), true);
    assert.ok(on.env.document.getElementById("app"));
    on.env.close();
  });
});

after(closeAll);
