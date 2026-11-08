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
  test("login from the welcome page remembers where to go back to; finishLogin hands it to auth.html", async () => {
    const { env, C } = boot();
    await C.loginUrl("welcome.html");
    const { state } = env.storage.cloudAuthPending;
    assert.equal(env.storage.cloudAuthPending.back, "welcome.html");
    const r = await C.finishLogin({ code: "c1", state });
    assert.equal(r.back, "welcome.html");
    env.close();
  });
  test("login from the popup opens a small window (not a tab) when the browser has windows", async () => {
    const { env, C } = boot();
    const wins = [];
    env.chrome.windows = { create: (o, cb) => { wins.push(o); cb && cb({ id: 1 }); } };
    await C.startLogin();
    assert.equal(wins.length, 1);
    assert.equal(wins[0].type, "popup");
    assert.match(wins[0].url, /\/auth\/oauth\/google\/start\?/);
    assert.equal(env.createdTabs.length, 0);
    assert.equal(env.storage.cloudAuthPending.back, undefined);
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
  test("backup removes from the cloud what this computer has at its default (stale values from an older backup don't come back)", async () => {
    const docs = { extension: { data: { uiTheme: "light", showDebug: true, cdnHost: "old", futureField: 1 }, rev: 4, updatedAt: 1, updatedBy: "extension" } };
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, cdnHost: "a.bilivideo.com" }, docs });
    await C.backup();
    const d = srv.docs.extension.data;
    assert.equal(d.cdnHost, "a.bilivideo.com");
    assert.equal("uiTheme" in d, false);
    assert.equal("showDebug" in d, false);
    assert.equal(d.futureField, 1, "fields this extension doesn't know are kept");
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
    assert.equal("uiLang" in s, false, "not in the backup → the backed-up machine had the default, so back to the default");
    assert.equal(s.uiMsgs, null);
    assert.equal(s.reportHistory.length, 1, "malformed field ignored");
    assert.equal("unknown" in s, false);
    assert.equal(s.countryAutoDone, true);
    assert.equal(s.installTestPending, false, "install optimization cancelled");
    assert.equal("cdnListPending" in s, false);
    assert.equal(typeof s.cloudAppliedAt, "number", "an open popup reloads to show the restored settings");
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
    assert.deepEqual(plain(C.lastBackup({ shared: { data: { customHosts: [] }, rev: 1, updatedAt: 5, updatedBy: "android" }, extension: { data: { a: 1 }, rev: 2, updatedAt: 9, updatedBy: "extension" } })), { at: 9, by: "extension" });
    assert.equal(C.lastBackup({ extension: { data: {}, rev: 3, updatedAt: 9, updatedBy: "extension" } }), null, "emptied backup counts as none");
    env.close();
  });
});

describe("auto sync", () => {
  const settle = (env) => env.settle(30);
  test("turning it on uploads everything local once (one-way: the cloud never overwrites this computer)", async () => {
    const docs = { extension: { data: { stVideoMb: 9, cdnHost: "cloud.bilivideo.com", fromApp: 1 }, rev: 3, updatedAt: 1, updatedBy: "extension" } };
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, stVideoMb: 4, autoFallback: false, cdnHost: "mine.bilivideo.com" }, docs });
    await C.setAuto(true);
    assert.equal(env.storage.cloudSync.auto, true);
    assert.equal(env.storage.stVideoMb, 4, "local stays as it is");
    assert.equal(env.storage.cdnHost, "mine.bilivideo.com");
    assert.equal(srv.docs.extension.data.stVideoMb, 4, "local wins in the cloud");
    assert.equal(srv.docs.extension.data.cdnHost, "mine.bilivideo.com", "current node is backed up too");
    assert.equal(srv.docs.extension.data.autoFallback, false);
    assert.equal(srv.docs.extension.data.fromApp, 1, "fields this extension doesn't know are kept");
    assert.deepEqual(Object.keys(env.alarms || {}), [], "no periodic pull");
    env.close();
  });
  test("turning it on stays off when the first upload fails", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, stVideoMb: 4 } });
    srv.down = true;
    await assert.rejects(C.setAuto(true));
    assert.equal(env.storage.cloudSync.auto, false);
    env.close();
  });
  test("a local change is pushed after a short delay; unchanged values and unrelated keys are ignored", async () => {
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: {}, snap: { stVideoMb: "4" }, dirty: [] } } });
    assert.equal(await C.onLocalChange({ stVideoMb: { newValue: 4 } }), false, "same as last synced");
    assert.equal(await C.onLocalChange({ detectedIp: { newValue: "1.1.1.1" } }), false, "not a backed-up field");
    env.chrome.storage.local.set({ stVideoMb: 6 });
    assert.equal(await C.onLocalChange({ stVideoMb: { newValue: 6 } }), true);
    assert.deepEqual(env.storage.cloudSync.dirty, ["stVideoMb"]);
    await C.push();
    assert.equal(srv.docs.extension.data.stVideoMb, 6);
    assert.deepEqual(env.storage.cloudSync.dirty, []);
    assert.equal(env.storage.cloudSync.snap.stVideoMb, "6");
    env.chrome.storage.local.set({ cdnHost: "x.bilivideo.com" });
    assert.equal(await C.onLocalChange({ cdnHost: { newValue: "x.bilivideo.com" } }), true, "switching node is backed up too");
    await C.push();
    assert.equal(srv.docs.extension.data.cdnHost, "x.bilivideo.com");
    env.close();
  });
  test("a setting put back to its default (removed from storage) is removed from the cloud too, and isn't re-sent forever", async () => {
    const docs = { extension: { data: { uiTheme: "light", stVideoMb: 6, fromApp: 1 }, rev: 2, updatedAt: 1, updatedBy: "extension" } };
    const { env, C, srv } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: { extension: 2 }, snap: { uiTheme: "\"light\"", stVideoMb: "6" }, dirty: [] } }, docs });
    assert.equal(await C.onLocalChange({ uiTheme: { oldValue: "light" } }), true);
    await C.push();
    assert.equal("uiTheme" in srv.docs.extension.data, false);
    assert.equal(srv.docs.extension.data.stVideoMb, 6);
    assert.equal(srv.docs.extension.data.fromApp, 1);
    assert.deepEqual(env.storage.cloudSync.dirty, [], "nothing left to send");
    assert.equal(await C.onLocalChange({ uiTheme: { oldValue: "light" } }), false, "already in sync");
    env.close();
  });
  test("another computer's change in the cloud is not pulled in automatically", async () => {
    const docs = { extension: { data: { stVideoMb: 9 }, rev: 5, updatedAt: 1, updatedBy: "extension" } };
    const { env, C } = boot({ storage: { ...ACCOUNT, stVideoMb: 6, cloudSync: { auto: true, rev: { extension: 4 }, snap: { stVideoMb: "6" }, dirty: [] } }, docs });
    assert.equal(C.pull, undefined, "no pull at all");
    await C.push();
    assert.equal(env.storage.stVideoMb, 6);
    assert.equal(env.storage.cloudAppliedAt, undefined);
    env.close();
  });
  test("restoring while auto sync is on doesn't send the restored values straight back", async () => {
    const docs = { extension: { data: { stVideoMb: 9, cdnCountry: "TW" }, rev: 5, updatedAt: 1, updatedBy: "extension" } };
    const { env, C } = boot({ storage: { ...ACCOUNT, stVideoMb: 6, cdnCountry: "JP", cloudSync: { auto: true, rev: { extension: 4 }, snap: {}, dirty: [] } }, docs });
    await C.restore();
    assert.equal(await C.onLocalChange({ stVideoMb: { newValue: 9 }, cdnCountry: { newValue: "TW" } }), false, "same as the snapshot saved before the write");
    assert.deepEqual(env.storage.cloudSync.dirty, []);
    env.close();
  });
  test("turning it off forgets pending changes", async () => {
    const { env, C } = boot({ storage: { ...ACCOUNT, cloudSync: { auto: true, rev: {}, snap: {}, dirty: ["x"] } } });
    await C.setAuto(false);
    assert.equal(env.storage.cloudSync.auto, false);
    assert.deepEqual(env.storage.cloudSync.dirty, []);
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
    assert.match(card.textContent, /Restore settings from cloud/);
    assert.equal(card.querySelectorAll(".bbcBtn.alt").length, 0, "no primary/secondary: every button looks the same");
    assert.doesNotMatch(card.textContent, /whenever a setting changes/, "no hint under auto sync");
    assert.match(card.querySelector(".bbcMeta").textContent, /^Last backup: [^()（）]+$/, "time only, no source");
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
  test("welcome page (fresh install), signed out: Google sign-in above 'Maybe later'", async () => {
    const { env, UI } = bootUi({});
    let later = 0;
    UI.mount(env.document.body, { fresh: true, back: "welcome.html", onLater: () => later++, laterText: "Maybe later" });
    await env.settle(30);
    const btns = [...env.document.querySelectorAll(".bbcBtn")].map((b) => b.textContent);
    assert.deepEqual(btns, ["Sign in with Google", "Maybe later"]);
    assert.equal(env.document.querySelector(".bbcBtns").classList.contains("row"), false, "stacked, not side by side");
    assert.match(env.document.body.textContent, /Used BiBoost before\?/);
    env.document.querySelectorAll(".bbcBtn")[1].click();
    assert.equal(later, 1);
    env.close();
  });
  test("welcome page (fresh install), signed in: asks to restore, one main-color button, no cancel or sign out; done → onDone", async () => {
    const { env, UI } = bootUi({ ...ACCOUNT, stVideoMb: 4 }, { extension: { data: { stVideoMb: 9 }, rev: 1, updatedAt: Date.UTC(2026, 10, 1), updatedBy: "extension" } });
    let done = 0;
    UI.mount(env.document.body, { fresh: true, onDone: () => done++ });
    await env.settle(40);
    const btns = [...env.document.querySelectorAll(".bbcBtn")];
    assert.deepEqual(btns.map((b) => b.textContent), ["Restore from cloud"], "no backup button, no cancel on a fresh install");
    assert.ok(btns[0].classList.contains("primary"));
    assert.equal(env.document.querySelector(".bbcAsk").textContent, "Restore your settings from the cloud?");
    assert.equal(env.document.querySelector(".bbcAsk").hidden, false);
    assert.equal(env.document.querySelector(".bbcLogout"), null, "sign out only lives in the popup dialog");
    assert.equal(env.document.querySelector(".bbcAuto"), null, "no auto sync switch (it would upload the fresh defaults)");
    btns[0].click();
    await env.settle(40);
    assert.equal(env.storage.stVideoMb, 9);
    assert.ok(env.document.querySelector(".bbcDone"));
    await env.settle(UI.DONE_MS + 100);
    assert.equal(done, 1);
    env.close();
  });
  test("welcome page (fresh install): nothing in the cloud → no question and no button, just 'No backup in the cloud yet'", async () => {
    const { env, UI } = bootUi({ ...ACCOUNT });
    UI.mount(env.document.body, { fresh: true });
    await env.settle(40);
    assert.equal(env.document.querySelector(".bbcAsk").hidden, true);
    assert.equal(env.document.querySelector(".bbcBtns").hidden, true);
    assert.match(env.document.querySelector(".bbcMeta").textContent, /No backup in the cloud yet/);
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
