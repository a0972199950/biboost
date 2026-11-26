// Neon Postgres 的 HTTP 查詢（節點清單的發布歷史 cdn_lists 用，見 cdn-list-history.mjs）。
// 連線字串：.env.local 或環境變數的 DATABASE_URL（正式環境）。
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile(path.join(ROOT, ".env.local"));
  } catch {
    // 沒有 .env.local 就看環境變數
  }
}

function getDbUrl() {
  loadEnv();
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) throw new Error("找不到 DATABASE_URL（.env.local 或環境變數）");
  return url;
}

export async function sql(query, params = []) {
  const url = getDbUrl();
  const host = new URL(url).hostname;
  const res = await fetch(`https://${host.replace(/^[^.]+\./, "api.")}/sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": url },
    body: JSON.stringify({ query, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Neon ${res.status}：${text.slice(0, 300)}`);
  return JSON.parse(text).rows || [];
}
