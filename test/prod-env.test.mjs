// 上架版的環境設定（scripts/lib/prod-env.mjs）：打包時 common.js 換成只有正式環境、manifest 拿掉測試環境網域，
// 上架版裡不能出現測試環境網址；src/ 本身是開發版（接測試環境）
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGING_HOST, findStaging, prodCommonJs, prodManifest } from "../scripts/lib/prod-env.mjs";
import { createEnv, readSrc, readSrcJson } from "./helpers/load.mjs";

test("prodCommonJs：@env 段換成只有正式環境，整份沒有測試環境網址", () => {
  const src = readSrc("common.js");
  assert.ok(src.includes(STAGING_HOST), "src/common.js 是開發版，有測試環境網址");
  const out = prodCommonJs(src);
  assert.ok(!out.includes(STAGING_HOST));
  assert.match(out, /var BB_ENV = "prod";/);
  assert.match(out, /var BB_API_STAGING = null;/);
  assert.throws(() => prodCommonJs("var x = 1;"), /找不到/);
});

test("prodManifest：兩份 manifest 的 host_permissions、web_accessible_resources 都拿掉測試環境網域", () => {
  for (const f of ["manifest.json", "manifest.firefox.json"]) {
    const m = readSrcJson(f);
    assert.ok(JSON.stringify(m).includes(STAGING_HOST), `${f} 開發版有測試環境`);
    const p = prodManifest(m);
    assert.ok(!JSON.stringify(p).includes(STAGING_HOST), `${f} 上架版沒有測試環境`);
    assert.ok(JSON.stringify(p).includes("https://api.biboost.app/*"), `${f} 正式環境還在`);
  }
});

test("findStaging 抓得到有測試環境網址的檔案", () => {
  assert.deepEqual(findStaging([["a.js", "x"], ["b.js", Buffer.from("https://" + STAGING_HOST)]]), ["b.js"]);
});

test("bbApiBase：開發版接測試環境、上架版接正式環境", async () => {
  const dev = createEnv({ devBuild: true });
  dev.load("common.js");
  assert.equal(await dev.window.bbApiBase(), "https://" + STAGING_HOST);
  assert.equal(await dev.window.bbIsDevBuild(), true);
  dev.close();
  const prod = createEnv();
  prod.load("common.js");
  assert.equal(await prod.window.bbApiBase(), "https://api.biboost.app");
  assert.equal(await prod.window.bbIsDevBuild(), false);
  prod.close();
});
