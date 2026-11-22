// 用 xcodebuild 打包 Safari 擴充（macOS / iOS），把產物 .app 匯出到 dist/。
// macOS-only：xcodebuild 只在裝了 Xcode 的 Mac 上能跑。
//
// Xcode 工程 (safari/Bilibili CDN Switcher/) 是 `xcrun safari-web-extension-converter`
// 產生的，裡面的擴充資源用相對路徑 ../../../src/ 直接引用倉庫的 src/，
// 所以這裡不需要同步／複製檔案，xcodebuild 會直接抓 src/ 最新內容進 .appex。
//
// 用法：
//   npm run build:safari                       # macOS，Release，ad-hoc 簽章，輸出到 dist/
//   npm run build:safari -- --platform=ios     # 改打包 iOS（產物是 .app，需真機/模擬器才能跑）
//   npm run build:safari -- --configuration=Debug
//
// 環境：Release 是上架版（只接正式環境），Debug 是開發版（接測試環境、popup 版號標「開發版」）。
// 在 Safari 實測時注意：Release 和 Debug 都建過的話，兩個 .app 會同時被系統登記（同一個 bundle id、同一個版本），
// Safari 不一定載入你剛建的那份。先用 `pluginkit -mAD | grep -i biboost` 看有幾份，把不用的那份 `pluginkit -r <.appex 路徑>`
// 取消登記（或刪掉 build/Build/Products 底下那個 .app）再重開 Safari；popup 版號有沒有「開發版」可以確認載到哪份。
//
// 注意：這裡是 ad-hoc 簽章（CODE_SIGN_IDENTITY="-"），產物僅供本機測試。
// 要上架 App Store 仍需在 Xcode 用你的 Apple Developer 帳號 Archive → 上傳，
// 這步無法純命令列在沒有簽章憑證的情況下完成。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { prodCommonJs, prodManifest } from "./lib/prod-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const PROJECT = path.join(ROOT, "safari", "Bilibili CDN Switcher", "Bilibili CDN Switcher.xcodeproj");
// derivedData 放在 safari/Bilibili CDN Switcher/build，對應 .gitignore 的 safari/*/build/
const DERIVED = path.join(ROOT, "safari", "Bilibili CDN Switcher", "build");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
}

const platform = arg("platform", "macos").toLowerCase();
const configuration = arg("configuration", "Release");

if (!["macos", "ios"].includes(platform)) {
  console.error(`未知的 --platform=${platform}，可用值：macos, ios`);
  process.exit(1);
}
if (!["Release", "Debug"].includes(configuration)) {
  console.error(`未知的 --configuration=${configuration}，可用值：Release, Debug`);
  process.exit(1);
}

const scheme = platform === "ios" ? "Bilibili CDN Switcher (iOS)" : "Bilibili CDN Switcher (macOS)";
const sdk = platform === "ios" ? "iphoneos" : "macosx";
const version = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8")).version;

if (!fs.existsSync(PROJECT)) {
  console.error(`找不到 Xcode 工程：${PROJECT}`);
  process.exit(1);
}

console.log(`\n🔨 xcodebuild  scheme="${scheme}"  configuration=${configuration}  v${version}\n`);

// ad-hoc 簽章（"-"）＋關閉需要 provisioning profile 的檢查，讓沒有開發者憑證也能build出本機可跑的 .app。
// MARKETING_VERSION 用 manifest 的版本覆蓋，讓 .app 內部版本跟擴充版本一致（Xcode 工程預設寫死 1.0）。
const buildArgs = [
  "-project", PROJECT,
  "-scheme", scheme,
  "-configuration", configuration,
  "-sdk", sdk,
  "-derivedDataPath", DERIVED,
  `MARKETING_VERSION=${version}`,
  "CODE_SIGN_IDENTITY=-",
  "CODE_SIGN_STYLE=Manual",
  "DEVELOPMENT_TEAM=",
  "PROVISIONING_PROFILE_SPECIFIER=",
  "build",
];

// Xcode 27 起 macOS 的最低版本只能設 12.0 以上，工程設定的 10.14 會直接建置失敗。本機用新版 Xcode 建來測試時自動補 12.0；
// 上架（GitHub Actions 的 Xcode 26.x）照工程設定，不受影響。要不要正式把最低版本改成 macOS 12 另外決定（會放棄 10.14～11 的使用者）
function xcodeMajor() {
  try { return Number((/Xcode (\d+)/.exec(execFileSync("xcodebuild", ["-version"], { encoding: "utf8" })) || [])[1]) || 0; }
  catch (e) { return 0; }
}
if (platform === "macos" && xcodeMajor() >= 27) {
  buildArgs.splice(buildArgs.length - 1, 0, "MACOSX_DEPLOYMENT_TARGET=12.0");
  console.log("ℹ️  Xcode 27 以上：本機建置的 macOS 最低版本暫時用 12.0（工程設定 10.14 在新版 Xcode 不支援；上架流程不受影響）\n");
}

// Release：Xcode 直接引用 src/，建置期間把 src/ 暫時改成上架版的環境設定（只有正式環境，scripts/lib/prod-env.mjs），建完一定還原。
// Debug 維持開發版（接測試環境）
const ENV_FILES = ["common.js", "manifest.json", "manifest.firefox.json"].map((f) => path.join(SRC, f));
const original = configuration === "Release" ? new Map(ENV_FILES.map((p) => [p, fs.readFileSync(p)])) : null;
let failed = false;
try {
  if (original) {
    fs.writeFileSync(ENV_FILES[0], prodCommonJs(original.get(ENV_FILES[0]).toString("utf8")));
    for (const p of ENV_FILES.slice(1)) fs.writeFileSync(p, JSON.stringify(prodManifest(JSON.parse(original.get(p).toString("utf8"))), null, 2) + "\n");
  }
  execFileSync("xcodebuild", buildArgs, { stdio: "inherit" });
} catch (e) {
  failed = true;
  console.error("\n❌ xcodebuild 失敗。常見原因：未安裝 Xcode（只有 Command Line Tools 不夠），或簽章設定衝突。");
} finally {
  if (original) for (const [p, buf] of original) fs.writeFileSync(p, buf);
}
if (failed) process.exit(1);

// 產物：build/Build/Products/<Configuration>[-iphoneos]/<PRODUCT_NAME>.app
const productDirName = platform === "ios" ? `${configuration}-iphoneos` : configuration;
// 名稱要跟 Xcode 工程 App target 的 PRODUCT_NAME 一致（App Store 不允許名稱含 bilibili，所以跟工程資料夾名不同）
const appName = "BiBoost - Video Speedup.app";
const builtApp = path.join(DERIVED, "Build", "Products", productDirName, appName);

if (!fs.existsSync(builtApp)) {
  console.error(`\n❌ build 完成但找不到產物：${builtApp}`);
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
const outApp = path.join(DIST, `Bilibili CDN Switcher (${platform}).app`);
fs.rmSync(outApp, { recursive: true, force: true });
fs.cpSync(builtApp, outApp, { recursive: true });

// 不打 zip：這個 .app 只是本機測試用（雙擊安裝），上架 App Store 走 Xcode Archive，
// 兩者都不需要 zip。要跨機器搬運再自己 `ditto -c -k --keepParent <.app> <name>.zip` 即可。

console.log(`\n✅ 完成`);
console.log(`   .app  -> ${outApp}`);
console.log(`\n本機測試：雙擊上面的 .app，再到 Safari > 設定 > 擴充功能 啟用。`);
console.log(`上架 App Store：用 Xcode 開啟工程 → Product > Archive → Distribute App（需 Apple Developer 帳號簽章）。`);
