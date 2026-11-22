// 上架版的環境設定：src/ 是開發用的（接測試環境），打包上架時把 src/common.js 的 @env-begin～@env-end 那段換成只有正式環境，
// manifest 裡含測試環境網域的權限也拿掉，最後檢查打包內容不能再出現測試環境的網址（像圖示一樣，上架時才換）。
// 用到的地方：scripts/build.mjs（Chrome／Edge／Firefox 的 zip）、scripts/build-site.mjs（biboost.app 的贊助頁）、
// scripts/prod-env.mjs（Safari：xcodebuild 直接讀 src/，上架前先改寫 src/ 再建置，見 .github/workflows/safari-appstore.yml）。

export const STAGING_HOST = "api-staging.biboost.app";
const ENV_BLOCK = /\/\/ @env-begin\r?\n[\s\S]*?\/\/ @env-end/;
export const PROD_ENV_BLOCK = [
  "// @env-begin",
  'var BB_ENV = "prod";',
  'var BB_API_PROD = "https://api.biboost.app";',
  "var BB_API_STAGING = null;",
  "// @env-end",
].join("\n");

// common.js 的文字 → 上架版（找不到標記就丟錯，免得默默打包出開發版）
export function prodCommonJs(text) {
  if (!ENV_BLOCK.test(text)) throw new Error("src/common.js 找不到 // @env-begin … // @env-end，沒辦法換成上架版的環境設定");
  const out = text.replace(ENV_BLOCK, PROD_ENV_BLOCK);
  if (out.includes(STAGING_HOST)) throw new Error("上架版的 common.js 還有測試環境的網址（@env 段以外也寫了？）");
  return out;
}

// manifest 物件 → 上架版：拿掉含測試環境網域的 host_permissions、web_accessible_resources 的 matches
export function prodManifest(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  const keep = (list) => (Array.isArray(list) ? list.filter((u) => !String(u).includes(STAGING_HOST)) : list);
  if (m.host_permissions) m.host_permissions = keep(m.host_permissions);
  if (m.permissions) m.permissions = keep(m.permissions); // MV2（Firefox 舊版）可能把網域寫在 permissions
  if (Array.isArray(m.web_accessible_resources)) {
    m.web_accessible_resources = m.web_accessible_resources.map((w) => (w && w.matches ? { ...w, matches: keep(w.matches) } : w));
  }
  return m;
}

// 打包後的檔案內容（字串或 Buffer）不能出現測試環境網域；回傳出現的檔名清單
export function findStaging(entries) {
  const bad = [];
  for (const [name, buf] of entries) {
    const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
    if (s.includes(STAGING_HOST)) bad.push(name);
  }
  return bad;
}
