// Safari 版的 Xcode 工程是「逐一檔案」引用 ../../../src/（safari-web-extension-converter 產生的；
// 不用整個資料夾引用，否則 src/private/ 也會被打包，且資源會落在 Resources/src/ 底下）。
// 所以在 src/ 新增檔案時，必須同時加進工程，不然 Chrome 版正常、Safari 版卻少了檔案。
// 這裡檢查：src/ 第一層每個檔案／資料夾（private/ 除外）都在每個 Safari 擴充 target 的 Resources 裡，
// 而且工程引用的 src 路徑都真的存在。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PBXPROJ = path.join(ROOT, "safari/Bilibili CDN Switcher/Bilibili CDN Switcher.xcodeproj/project.pbxproj");
const SRC_PREFIX = "../../../src/";
// 刻意不放進 Safari 版的 src 第一層項目
const NOT_IN_SAFARI = new Set(["private"]);

function parseProject(text) {
  // 物件：<id> /* 註解 */ = { ... };。PBXBuildFile／PBXFileReference 寫成一行，其他寫成多行
  //（多行的以 tab tab }; 結尾；內部的 ( ) 清單不含 { }）
  text = text.replace(/\r\n/g, "\n");
  const objects = {};
  let m;
  const oneLine = /^\t\t([0-9A-F]{24})(?: \/\*.*?\*\/)? = \{(isa = .*?)\};$/gm;
  while ((m = oneLine.exec(text))) objects[m[1]] = m[2];
  const multiLine = /^\t\t([0-9A-F]{24})(?: \/\*.*?\*\/)? = \{\n([\s\S]*?)\n\t\t\};$/gm;
  while ((m = multiLine.exec(text))) objects[m[1]] = m[2];
  const attr = (body, key) => { const r = new RegExp(`\\b${key} = ("(?:[^"\\\\]|\\\\.)*"|[^;]+);`).exec(body); return r ? r[1].replace(/\s*\/\*.*?\*\/\s*$/, "").replace(/^"|"$/g, "") : null; }; // 去掉值後面的 /* 註解 */
  const list = (body, key) => { const r = new RegExp(`\\b${key} = \\(([\\s\\S]*?)\\);`).exec(body); return r ? [...r[1].matchAll(/([0-9A-F]{24})/g)].map((x) => x[1]) : []; };
  return { objects, attr, list };
}

function extensionTargets() {
  const { objects, attr, list } = parseProject(fs.readFileSync(PBXPROJ, "utf8"));
  const targets = [];
  for (const [id, body] of Object.entries(objects)) {
    if (attr(body, "isa") !== "PBXNativeTarget" || attr(body, "productType") !== "com.apple.product-type.app-extension") continue;
    const phases = list(body, "buildPhases").filter((p) => objects[p] && attr(objects[p], "isa") === "PBXResourcesBuildPhase");
    const srcEntries = new Set();
    for (const ph of phases) {
      for (const bf of list(objects[ph], "files")) {
        const ref = objects[bf] && attr(objects[bf], "fileRef");
        const p = ref && objects[ref] && attr(objects[ref], "path");
        if (p && p.startsWith(SRC_PREFIX)) srcEntries.add(p.slice(SRC_PREFIX.length));
      }
    }
    targets.push({ id, name: attr(body, "name"), srcEntries });
  }
  return targets;
}

describe("Safari Xcode project references every src file", () => {
  const targets = extensionTargets();
  const srcTop = fs.readdirSync(path.join(ROOT, "src")).filter((f) => !NOT_IN_SAFARI.has(f) && !f.startsWith("."));

  test("the project has the macOS and iOS extension targets", () => {
    assert.equal(targets.length, 2, `extension targets: ${targets.map((t) => t.name).join(", ")}`);
    for (const t of targets) assert.ok(t.srcEntries.has("manifest.json"), `${t.name} has no manifest.json in Resources`);
  });

  test("every top-level src file / folder is in each extension target's Resources (add new src files to the Xcode project)", () => {
    for (const t of targets) {
      const missing = srcTop.filter((f) => !t.srcEntries.has(f));
      assert.deepEqual(missing, [], `${t.name} is missing: ${missing.join(", ")} — add them to the Xcode project (both extension targets), or to NOT_IN_SAFARI in this test if Safari must not ship them`);
    }
  });

  test("every src path the project references exists", () => {
    for (const t of targets) {
      const gone = [...t.srcEntries].filter((f) => !fs.existsSync(path.join(ROOT, "src", f)));
      assert.deepEqual(gone, [], `${t.name} references missing files: ${gone.join(", ")}`);
    }
  });
});
