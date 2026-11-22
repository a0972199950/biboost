// Safari 上架前用：Xcode 專案直接引用 src/（不經過 build.mjs 打包），所以上架建置前先把 src/ 改寫成上架版——
// common.js 的環境設定只留正式環境、manifest.json 拿掉測試環境網域，再檢查 src/ 裡沒有測試環境網址。
//   node scripts/prod-env.mjs            改寫 src/（.github/workflows/safari-appstore.yml 在 xcodebuild archive 前跑；CI 的工作目錄用完就丟）
//   node scripts/prod-env.mjs --check    只檢查、不改（看 src/ 現在是不是上架版）
// 本機跑過之後要還原：git checkout -- src/common.js src/manifest.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGING_HOST, findStaging, prodCommonJs, prodManifest } from "./lib/prod-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const CHECK = process.argv.includes("--check");

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "private" ? [] : listFiles(p);
    return [p];
  });
}

if (!CHECK) {
  const common = path.join(SRC, "common.js");
  fs.writeFileSync(common, prodCommonJs(fs.readFileSync(common, "utf8")));
  // Safari 用 src/manifest.json（Firefox 的 manifest.firefox.json 不會被 Xcode 打包，但一起改，免得被掃到）
  for (const f of ["manifest.json", "manifest.firefox.json"]) {
    const p = path.join(SRC, f);
    fs.writeFileSync(p, JSON.stringify(prodManifest(JSON.parse(fs.readFileSync(p, "utf8"))), null, 2) + "\n");
  }
}

const leaked = findStaging(listFiles(SRC).map((p) => [path.relative(SRC, p), fs.readFileSync(p)]));
if (leaked.length) {
  console.error(`src/ 還有測試環境網址（${STAGING_HOST}）：${leaked.join("、")}`);
  process.exit(1);
}
console.log(CHECK ? "src/ 是上架版：沒有測試環境網址" : "src/ 已改成上架版（只有正式環境）");
