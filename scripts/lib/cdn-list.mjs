// 節點清單（伺服器下發，擴充端見 src/cdn-list.js）：發布、拉取、歷史、差異。CLI 是 scripts/cdn-list.mjs。
//   · 來源：兩個互相獨立的靜態網站，放同一份簽好章的檔案
//       主要：Cloudflare Worker（只有靜態檔，tools/static-site/，掛 static.biboost.app；請求免費、不算 Workers 額度）
//       備援：AWS S3 biboost-static ＋ CloudFront（dv1itfovv5waq.cloudfront.net）
//     檔案：cdn-list/latest.json → { v, file }（快取 60 秒）、cdn-list/v/<v>.jws（內容永遠不變，快取一年）
//   · 歷史：Neon 的 cdn_lists（version, data, jws, note, published, created_at）。使用者拿清單時不經過資料庫
//   · 簽章：本機用 .env.local 的 FEATURES_SIGNING_KEY（同 /v1/features，kid f1），payload = { typ: "cdn-list", v, iat, data }
//   · 格式與網域白名單的檢查跟擴充共用同一份程式（在 Node 裡執行 src/cdn-list.js）
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "./lotteries.mjs";
import { diff, history, getVersion, ensureTable } from "./cdn-list-history.mjs";
import { signJws, KID } from "../../tools/report-worker/src/features.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORK_FILE = path.join(ROOT, ".cdn-list", "cdn-list.json"); // 本機工作檔（gitignored）：pull 寫入、publish 讀取
export const SITE_DIR = path.join(ROOT, "tools", "static-site", "public"); // 部署到 static.biboost.app 的內容（每次發布重建，gitignored）
const SITE_CONFIG = path.join(ROOT, "tools", "static-site", "wrangler.toml");
export const S3_BUCKET = "biboost-static";
const S3_REGION = "ap-southeast-1";
const KEEP_VERSIONS = 5; // 網站上保留最近幾版的 .jws（快取裡的舊 latest.json 指到的檔案還要拿得到）
const CACHE_LATEST = "public, max-age=60";
const CACHE_VERSION = "public, max-age=31536000, immutable";

export class CdnListError extends Error {}
export { diff, history, getVersion };

function loadEnv() {
  try { process.loadEnvFile(path.join(ROOT, ".env.local")); } catch { /* 沒有 .env.local 就看環境變數 */ }
}

// 擴充的 src/cdn-list.js（BBCdnList）：validate、check（驗章）、defaultHost、SOURCES
let ext = null;
export function extModule() {
  if (ext) return ext;
  const ctx = { atob, btoa, TextEncoder, TextDecoder, crypto, setTimeout, clearTimeout, AbortController, fetch };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "cdn-list.js"), "utf8") + "\n;globalThis.__out = BBCdnList;", ctx);
  ext = ctx.__out;
  return ext;
}

export function validate(data) {
  return Array.from(extModule().validate(data));
}

// ---- 線上版本 ----
// → { v, data, source }；兩個來源都失敗就 throw。sources：只問其中幾個（驗證發布結果用）
export async function fetchLive({ sources } = {}) {
  const m = extModule();
  const errs = [];
  for (const base of sources || m.SOURCES) {
    try {
      const latest = await (await okFetch(base + "cdn-list/latest.json")).json();
      const jws = (await (await okFetch(base + latest.file)).text()).trim();
      const p = await m.check(jws, latest.v);
      if (!p) throw new Error("驗章或格式檢查沒過");
      return { v: p.v, data: JSON.parse(JSON.stringify(p.data)), source: base };
    } catch (e) {
      errs.push(`${base}：${e.message}`);
    }
  }
  throw new CdnListError("拿不到線上清單：\n  " + errs.join("\n  "));
}
async function okFetch(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r;
}

// ---- 工作檔格式：跟原本的 src/cdn-list.json 一樣，一個國家／一個節點一行，方便看 diff ----
export function format(data) {
  const j = (v) => JSON.stringify(v);
  const out = ["{"];
  const keys = Object.keys(data);
  keys.forEach((k, ki) => {
    const last = ki === keys.length - 1 ? "" : ",";
    const v = data[k];
    if (k === "countries" && Array.isArray(v)) {
      out.push(`  "countries": [`);
      v.forEach((c, i) => {
        const head = Object.entries(c).filter(([kk]) => kk !== "nodes").map(([kk, vv]) => `${j(kk)}: ${j(vv)}`).join(", ");
        out.push(`    {`, `      ${head},`, `      "nodes": [`);
        (c.nodes || []).forEach((h, hi) => out.push(`        ${j(h)}${hi === c.nodes.length - 1 ? "" : ","}`));
        out.push(`      ]`, `    }${i === v.length - 1 ? "" : ","}`);
      });
      out.push(`  ]${last}`);
    } else if (k === "options" && Array.isArray(v)) {
      out.push(`  "options": [`);
      v.forEach((o, i) => out.push(`    ${j(o)}${i === v.length - 1 ? "" : ","}`));
      out.push(`  ]${last}`);
    } else if (k === "pools" && v && typeof v === "object") {
      out.push(`  "pools": {`);
      const ps = Object.keys(v);
      ps.forEach((p, i) => out.push(`    ${j(p)}: ${j(v[p])}${i === ps.length - 1 ? "" : ","}`));
      out.push(`  }${last}`);
    } else {
      out.push(`  ${j(k)}: ${j(v)}${last}`);
    }
  });
  out.push("}");
  return out.join("\n") + "\n";
}

export function readWorkFile(file = WORK_FILE) {
  if (!fs.existsSync(file)) throw new CdnListError(`找不到 ${path.relative(ROOT, file)}：先跑 npm run cdn-list:pull`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new CdnListError(`${path.relative(ROOT, file)} 不是合法的 JSON：${e.message}`); }
}
export function writeWorkFile(data, file = WORK_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, format(data));
}

// ---- 發布 ----
// npx 在 Windows 是 .cmd，要經過 shell；aws 是真的執行檔，不經過 shell（參數有空白、分號也不用另外加引號）
function run(cmd, args, env) {
  const shell = cmd === "npx" && process.platform === "win32";
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell, encoding: "utf8" });
  if (r.status !== 0) throw new CdnListError(`${cmd} ${args.slice(0, 3).join(" ")} 失敗：\n${(r.stderr || r.stdout || "").trim().slice(-1500)}`);
  return r.stdout;
}
function awsEnv() {
  const id = (process.env.STATIC_AWS_ACCESS_KEY_ID || "").trim(), secret = (process.env.STATIC_AWS_SECRET_ACCESS_KEY || "").trim();
  if (!id || !secret) throw new CdnListError("找不到 STATIC_AWS_ACCESS_KEY_ID／STATIC_AWS_SECRET_ACCESS_KEY（.env.local）");
  const env = { ...process.env, AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: S3_REGION, AWS_DEFAULT_REGION: S3_REGION };
  delete env.AWS_PROFILE;
  delete env.AWS_SESSION_TOKEN;
  return env;
}
function s3Put(file, key, contentType, cacheControl, env) {
  run("aws", ["s3", "cp", file, `s3://${S3_BUCKET}/${key}`, "--content-type", contentType, "--cache-control", cacheControl, "--only-show-errors"], env);
}

// 重建 tools/static-site/public：最近 KEEP_VERSIONS 個已發布版本＋這次的版本、latest.json、_headers
function buildSite(rows, latestV) {
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE_DIR, "cdn-list", "v"), { recursive: true });
  for (const r of rows) fs.writeFileSync(path.join(SITE_DIR, "cdn-list", "v", `${r.version}.jws`), r.jws);
  fs.writeFileSync(path.join(SITE_DIR, "cdn-list", "latest.json"), JSON.stringify({ v: latestV, file: `cdn-list/v/${latestV}.jws` }));
  fs.writeFileSync(path.join(SITE_DIR, "_headers"), [
    "/*", "  Access-Control-Allow-Origin: *", "  X-Content-Type-Options: nosniff",
    "/cdn-list/latest.json", `  Cache-Control: ${CACHE_LATEST}`,
    "/cdn-list/v/*", `  Cache-Control: ${CACHE_VERSION}`, "  Content-Type: text/plain; charset=utf-8", ""
  ].join("\n"));
}

// data → 新版本上線。回傳 { version }。note：發布紀錄的備註
export async function publish(data, { note = "", log = console.log } = {}) {
  loadEnv();
  const errs = validate(data);
  if (errs.length) throw new CdnListError("清單沒通過檢查：\n  " + errs.join("\n  "));
  const key = (process.env.FEATURES_SIGNING_KEY || "").trim();
  if (!key) throw new CdnListError("找不到 FEATURES_SIGNING_KEY（.env.local）");
  const env = awsEnv();
  await ensureTable();

  const [{ version }] = await sql("insert into cdn_lists (data, note) values ($1::jsonb, $2) returning version", [JSON.stringify(data), note]);
  const jws = await signJws({ typ: "cdn-list", v: version, iat: Math.floor(Date.now() / 1000), data }, key, KID);
  const check = await extModule().check(jws, version);
  if (!check) throw new CdnListError("簽好的檔案用擴充內建的公鑰驗不過（私鑰跟 src/cdn-list.js 的公鑰不是一對？）");
  await sql("update cdn_lists set jws = $1 where version = $2", [jws, version]);
  log(`第 ${version} 版：已記進資料庫並簽章`);

  const rows = await sql("select version, jws from cdn_lists where (published or version = $1) and jws is not null order by version desc limit $2", [version, KEEP_VERSIONS]);
  buildSite(rows, version);
  // 備援先放版本檔，兩邊都放好版本檔後才換 latest.json（latest 指到的檔案一定拿得到）
  s3Put(path.join(SITE_DIR, "cdn-list", "v", `${version}.jws`), `cdn-list/v/${version}.jws`, "text/plain; charset=utf-8", CACHE_VERSION, env);
  log("備援（S3）：版本檔已上傳");
  run("npx", ["wrangler", "deploy", "--config", SITE_CONFIG], process.env);
  log("主要（static.biboost.app）：已部署");
  s3Put(path.join(SITE_DIR, "cdn-list", "latest.json"), "cdn-list/latest.json", "application/json; charset=utf-8", CACHE_LATEST, env);
  log("備援（S3）：latest.json 已更新");
  await sql("update cdn_lists set published = true where version = $1", [version]);
  return { version };
}

// 發布後確認兩個來源都拿得到這一版（latest.json 快取 60 秒，最多等 maxWaitMs）
export async function verifyLive(version, { maxWaitMs = 150000, log = console.log } = {}) {
  const out = {};
  for (const base of extModule().SOURCES) {
    const t0 = Date.now();
    for (;;) {
      let got = null, err = "";
      try { got = (await fetchLive({ sources: [base] })).v; } catch (e) { err = e.message; }
      if (got === version) { out[base] = true; log(`✓ ${base} 已經是第 ${version} 版`); break; }
      if (Date.now() - t0 > maxWaitMs) { out[base] = false; log(`✗ ${base} 還是 ${got ?? err}（快取還沒過期？稍後再跑 npm run cdn-list:status）`); break; }
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  return out;
}
