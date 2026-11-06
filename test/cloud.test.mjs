// src/cloud.js（雲端備份）＋ cloud-ui.js（視窗）。後台用記憶體裡的假伺服器，行為照 biboost-mobile 的 /me/settings（rev 樂觀鎖、整份取代）
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, plain, closeAll } from "./helpers/load.mjs";

after(closeAll);
const API = "https://api.biboost.app";
const TOKEN = "a".repeat(64);
const ACCOUNT = { cloudAccount: { api: API, token: TOKEN, email: "me@example.com" } };

// 假後台：docs = { ns: { data, rev, updatedAt, updatedBy } }
function fakeServer(docs = {}) {
  const srv = { docs, calls: [], exchange: null, down: false, conflictOnce: null };
  srv.handle = (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    srv.calls.push({ method, path: u.pathname, body, auth: init.headers && init.headers.Authorization });
    if (srv.down) throw new TypeError("Failed to fetch");
    const reply = (status, obj) => ({ ok: status < 300, status, json: () => Promise.resolve(obj) });
    if (u.pathname === "/auth/oauth/exchange") {
      srv.exchange = body;
      return reply(200, { token: TOKEN, account: { email: "me@example.com" } });
    }
    if (u.pathname === "/auth/logout") return reply(200, { ok: true });
    if (init.headers?.Authorization !== "Bearer " + TOKEN) return reply(401, { error: "bad_token" });
    if (method === "GET" && u.pathname === "/me/settings") return reply(200, JSON.parse(JSON.stringify(srv.docs)));
    const m = u.pathname.match(/^\/me\/settings\/(\w+)$/);
    if (method === "PUT" && m) {
      const ns = m[1], cur = srv.docs[ns] || { data: {}, rev: 0 };
      if (srv.conflictOnce === ns) {
        srv.conflictOnce = null;
        srv.docs[ns] = { data: { ...cur.data, fromOther: 1 }, rev: cur.rev + 1, updatedAt: 2, updatedBy: "android" };
        return reply(409, { error: "conflict", current: srv.docs[ns] });
      }
      if (body.baseRev !== cur.rev) return reply(409, { error: "conflict", current: cur });
      srv.docs[ns] = { data: body.data, rev: cur.rev + 1, updatedAt: Date.now(), updatedBy: body.client };
      return reply(200, srv.docs[ns]);
    }
    return reply(404, { error: "not_found" });
  };
  return srv;
}
function boot({ storage = {}, docs, html } = {}) {
  const env = createEnv({ storage, html });
  const srv = fakeServer(docs);
  env.fetchHandler = srv.handle;
  env.load("cloud.js");
  return { env, C: env.internals("cloud"), srv };
}

describe("login (PKCE)", () => {
  test("loginUrl carries state, our auth.html and the S256 challenge of the stored verifier", async () => {
    const { env, C } = boot();
    const url = new URL(await C.loginUrl());
    assert.equal(url.origin + url.pathname, API + "/auth/oauth/google/start");
    assert.equal(url.searchParams.get("return"), "chrome-extension://bcs-test/auth.html");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const p = env.storage.cloudAuthPending;
    assert.equal(url.searchParams.get("state"), p.state);
    assert.equal(url.searchParams.get("code_challenge"), await C.challengeOf(p.verifier));
    assert.ok(p.verifier.length >= 43);
    env.close();
  });
  test("finishLogin exchanges with the verifier and stores the account; the pending login is used up", async () => {
    const { env, C, srv } = boot();
    await C.loginUrl();
    const { state, verifier } = env.storage.cloudAuthPending;
    const r = await C.finishLogin({ code: "c1", state });
    assert.equal(r.email, "me@example.com");
    assert.deepEqual(srv.exchange, { code: "c1", state, code_verifier: verifier });
    assert.deepEqual(env.storage.cloudAccount, { api: API, token: TOKEN, email: "me@example.com" });
    assert.equal("cloudAuthPending" in env.storage, false);
    await assert.rejects(C.finishLogin({ code: "c1", state }), { code: "bad_state" });
    env.close();
  });
  test("a wrong state or an error from the server never exchanges", async () => {
    const { env, C, srv } = boot();
    await C.loginUrl();
    await assert.rejects(C.finishLogin({ code: "c1", state: "forged" }), { code: "bad_state" });
    await assert.rejects(C.finishLogin({ error: "access_denied", state: "x" }), { code: "access_denied" });
    assert.equal(srv.exchange, null);
    assert.equal("cloudAccount" in env.storage, false);
    env.close();
  });
  test("logout calls the server, forgets the token and turns auto sync off", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: { extension: 3 }, snap: {}, dirty: ["x"], lastUp: 5 } } });
    await C.logout();
    assert.ok(srv.calls.some((c) => c.path === "/auth/logout"));
    assert.equal("cloudAccount" in env.storage, false);
    assert.equal(env.storage.cloudSync.auto, false);
    assert.equal(env.storage.cloudSync.lastUp, 5);
    env.close();
  });
  test("a 401 signs the user out locally", async () => {
    const { env, C } = boot({ storage: { cloudAccount: { api: API, token: "b".repeat(64), email: "x" } } });
    await assert.rejects(C.backup(), { code: "unauthorized" });
    assert.equal("cloudAccount" in env.storage, false);
    env.close();
  });
});

describe("manual backup / restore", () => {
  const LOCAL = { cdnMode: "list", cdnCountry: "JP", cdnHost: "a.bilivideo.com", customHosts: ["c.bilivideo.com"], uiLang: "ja", uiTheme: "dark", stVideoMb: 4, reportHistory: [{ n: 1, url: "u", t: 1, type: "bug" }], detectedIp: "1.2.3.4", installedAt: 9 };
  test("backup writes shared + extension, keeps fields it doesn't know, leaves device-only data out", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, ...LOCAL }, docs: { extension: { data: { futureField: 1, cdnHost: "old" }, rev: 4, updatedAt: 1, updatedBy: "extension" } } });
    await C.backup();
    assert.deepEqual(srv.docs.shared.data, { customHosts: ["c.bilivideo.com"] });
    const ext = srv.docs.extension.data;
    assert.equal(ext.futureField, 1, "unknown field kept");
    assert.equal(ext.cdnHost, "a.bilivideo.com");
    assert.equal(ext.cdnCountry, "JP");
    assert.equal(ext.uiLang, "ja");
    assert.equal(ext.reportHistory.length, 1);
    assert.equal("detectedIp" in ext, false);
    assert.equal("installedAt" in ext, false);
    assert.equal(srv.docs.extension.updatedBy, "extension");
    assert.deepEqual(env.storage.cloudSync.rev, { shared: 1, extension: 5 });
    assert.ok(env.storage.cloudSync.lastUp > 0);
    env.close();
  });
  test("a conflict while backing up retries on top of the newer copy", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, ...LOCAL } });
    srv.conflictOnce = "extension";
    await C.backup();
    assert.equal(srv.docs.extension.data.fromOther, 1);
    assert.equal(srv.docs.extension.data.cdnHost, "a.bilivideo.com");
    env.close();
  });
  test("restore overwrites the backed-up fields, marks the user as not new, leaves other fields alone", async () => {
    const docs = {
      shared: { data: { customHosts: ["z.bilivideo.com"] }, rev: 2, updatedAt: 1, updatedBy: "extension" },
      extension: { data: { cdnMode: "custom", cdnCountry: "TW", cdnHost: "z.bilivideo.com", uiTheme: "light", stVideoMb: 9, unknown: 1, reportHistory: "bad" }, rev: 7, updatedAt: 1, updatedBy: "extension" }
    };
    const { env, C } = boot({ storage: { ...ACCOUNT, ...LOCAL, installTestPending: true, cdnListPending: "install" }, docs });
    await C.restore();
    const s = env.storage;
    assert.deepEqual(s.customHosts, ["z.bilivideo.com"]);
    assert.equal(s.cdnMode, "custom");
    assert.equal(s.cdnCountry, "TW");
    assert.equal(s.cdnHost, "z.bilivideo.com");
    assert.equal(s.uiTheme, "light");
    assert.equal(s.stVideoMb, 9);
    assert.equal(s.uiLang, "ja", "not in the backup → untouched");
    assert.equal(s.reportHistory.length, 1, "malformed field ignored");
    assert.equal("unknown" in s, false);
    assert.equal(s.countryAutoDone, true);
    assert.equal(s.installTestPending, false, "install optimization cancelled");
    assert.equal("cdnListPending" in s, false);
    assert.deepEqual(s.cloudSync.rev, { shared: 2, extension: 7 });
    env.close();
  });
  test("restore with nothing in the cloud fails without touching anything", async () => {
    const { env, C } = boot({ storage: { ...ACCOUNT, ...LOCAL, installTestPending: true } });
    await assert.rejects(C.restore(), { code: "no_backup" });
    assert.equal(env.storage.installTestPending, true);
    env.close();
  });
  test("not logged in / offline errors", async () => {
    const { env, C, srv } = boot();
    await assert.rejects(C.backup(), { code: "not_logged_in" });
    env.chrome.storage.local.set(ACCOUNT);
    srv.down = true;
    await assert.rejects(C.backup(), { code: "network" });
    env.close();
  });
  test("lastBackup picks the newest namespace", () => {
    const { env, C } = boot();
    assert.equal(C.lastBackup({}), null);
    assert.deepEqual(plain(C.lastBackup({ shared: { data: {}, rev: 1, updatedAt: 5, updatedBy: "android" }, extension: { data: {}, rev: 2, updatedAt: 9, updatedBy: "extension" } })), { at: 9, by: "extension" });
    env.close();
  });
});

describe("auto sync", () => {
  const settle = (env) => env.settle(30);
  test("turning it on pulls the cloud first, then pushes fields the cloud doesn't have; device fields stay local", async () => {
    const docs = { extension: { data: { stVideoMb: 9, cdnHost: "cloud.bilivideo.com" }, rev: 3, updatedAt: 1, updatedBy: "extension" } };
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, stVideoMb: 4, autoFallback: false, cdnHost: "mine.bilivideo.com" }, docs });
    await C.setAuto(true);
    await settle(env);
    assert.equal(env.storage.stVideoMb, 9, "cloud wins");
    assert.equal(env.storage.cdnHost, "mine.bilivideo.com", "current node is never auto-synced");
    assert.equal(srv.docs.extension.data.autoFallback, false, "local-only field pushed");
    assert.equal(srv.docs.extension.data.cdnHost, "cloud.bilivideo.com", "device field not pushed either");
    assert.ok(env.alarms.cloudSyncPull, "pulls every 15 minutes");
    env.close();
  });
  test("a local change is pushed after a short delay; unchanged values and device fields are ignored", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: {}, snap: { stVideoMb: "4" }, dirty: [] } } });
    assert.equal(await C.onLocalChange({ stVideoMb: { newValue: 4 } }), false, "same as last synced");
    assert.equal(await C.onLocalChange({ cdnHost: { newValue: "x.bilivideo.com" } }), false, "device field");
    assert.equal(await C.onLocalChange({ detectedIp: { newValue: "1.1.1.1" } }), false, "not a backed-up field");
    env.chrome.storage.local.set({ stVideoMb: 6 });
    assert.equal(await C.onLocalChange({ stVideoMb: { newValue: 6 } }), true);
    assert.deepEqual(env.storage.cloudSync.dirty, ["stVideoMb"]);
    await C.push();
    assert.equal(srv.docs.extension.data.stVideoMb, 6);
    assert.deepEqual(env.storage.cloudSync.dirty, []);
    assert.equal(env.storage.cloudSync.snap.stVideoMb, "6");
    env.close();
  });
  test("pull applies newer cloud values but never overwrites a field still waiting to be pushed", async () => {
    const docs = { extension: { data: { stVideoMb: 9, autoFallback: false, cdnCountry: "TW" }, rev: 5, updatedAt: 1, updatedBy: "extension" } };
    const { env, C } = boot({ storage: { ...ACCOUNT, stVideoMb: 6, autoFallback: true, cdnCountry: "JP", cloudSync: { auto: true, rev: { extension: 4 }, snap: {}, dirty: ["stVideoMb"] } }, docs });
    const r = await C.pull();
    assert.equal(r.applied, 1);
    assert.equal(env.storage.autoFallback, false);
    assert.equal(env.storage.stVideoMb, 6, "dirty field kept");
    assert.equal(env.storage.cdnCountry, "JP", "device field kept");
    assert.equal(env.storage.cloudSync.rev.extension, 5);
    env.close();
  });
  test("pull does nothing when auto sync is off or the cloud has nothing newer", async () => {
    const docs = { extension: { data: { autoFallback: false }, rev: 5 } };
    const off = boot({ storage: { ...ACCOUNT, autoFallback: true }, docs });
    assert.equal((await off.C.pull()).applied, 0);
    assert.equal(off.srv.calls.length, 0);
    off.env.close();
    const same = boot({ storage: { ...ACCOUNT, autoFallback: true, cloudSync: { auto: true, rev: { extension: 5 }, snap: {}, dirty: [] } }, docs });
    assert.equal((await same.C.pull()).applied, 0);
    assert.equal(same.env.storage.autoFallback, true);
    same.env.close();
  });
  test("turning it off stops the alarm and forgets pending changes", async () => {
    const { env, C } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: {}, snap: {}, dirty: ["x"] } } });
    env.alarms.cloudSyncPull = {};
    await C.setAuto(false);
    assert.equal(env.storage.cloudSync.auto, false);
    assert.deepEqual(env.storage.cloudSync.dirty, []);
    assert.equal("cloudSyncPull" in env.alarms, false);
    env.close();
  });
});

describe("cloud dialog", () => {
  function bootUi(storage, docs) {
    const env = createEnv({ storage });
    const srv = fakeServer(docs);
    env.fetchHandler = srv.handle;
    ["i18n.js", "common.js", "cloud.js", "cloud-ui.js"].forEach((f) => env.load(f));
    return { env, UI: env.internals("cloud-ui"), srv };
  }
  test("signed out: only the Google button; clicking it opens the login tab", async () => {
    const { env, UI } = bootUi({});
    UI.open();
    await env.settle(30);
    const card = env.document.querySelector(".bbcCard");
    assert.match(card.textContent, /Sign in with Google/);
    assert.equal(card.querySelectorAll(".bbcBtn").length, 1);
    card.querySelector(".bbcBtn").click();
    await env.settle(30);
    assert.match(env.createdTabs[0].url, /^https:\/\/api\.biboost\.app\/auth\/oauth\/google\/start\?/);
    env.close();
  });
  test("signed in: email, both buttons, last backup, auto sync, sign out; backup plays the success animation then closes", async () => {
    const { env, UI, srv } = bootUi({ ...ACCOUNT, stVideoMb: 4 }, { extension: { data: { a: 1 }, rev: 1, updatedAt: Date.UTC(2026, 10, 1), updatedBy: "extension" } });
    UI.open();
    await env.settle(40);
    const card = env.document.querySelector(".bbcCard");
    assert.match(card.textContent, /Signed in as me@example\.com/);
    assert.match(card.textContent, /Back up to cloud/);
    assert.match(card.textContent, /Restore from cloud/);
    assert.match(card.querySelector(".bbcMeta").textContent, /^Last backup: .*\(browser extension\)$/);
    assert.ok(card.querySelector(".bbcAuto input"));
    assert.ok(card.querySelector(".bbcLogout"));
    card.querySelector(".bbcBtn").click();
    await env.settle(40);
    assert.equal(srv.docs.extension.data.stVideoMb, 4);
    assert.ok(env.document.querySelector(".bbcDone"), "success animation");
    await env.settle(UI.DONE_MS + 100);
    assert.equal(env.document.querySelector(".bbcMask"), null, "closed by itself");
    env.close();
  });
  test("restore with no backup shows the error and keeps the dialog open", async () => {
    const { env, UI } = bootUi({ ...ACCOUNT });
    UI.open();
    await env.settle(40);
    env.document.querySelectorAll(".bbcBtn")[1].click();
    await env.settle(40);
    assert.match(env.document.querySelector(".bbcErr").textContent, /No backup in the cloud yet/);
    assert.ok(env.document.querySelector(".bbcMask"));
    env.close();
  });
});
