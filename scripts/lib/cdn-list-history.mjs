// 節點清單的發布歷史與差異（Neon 的 cdn_lists）。只用資料庫，不碰檔案系統：
// 後台（scripts/lib/admin-api.mjs，本機與雲端 Worker 共用）跟發布工具（scripts/lib/cdn-list.mjs）都用這份。
import { sql } from "./lotteries.mjs";

const defaultHost = (d) => ((d && d.countries) || []).find((c) => c.code === "OTHER")?.nodes?.[0] || "";

// ---- 差異（給人看的摘要）----
export function diff(a, b) {
  const lines = [];
  a = a || { countries: [], options: [], pools: {} };
  const name = (c) => (c.name && (c.name.zh_TW || c.name.en)) || c.code;
  const ac = new Map((a.countries || []).map((c) => [c.code, c]));
  const bc = new Map((b.countries || []).map((c) => [c.code, c]));
  for (const [code, c] of bc) {
    const old = ac.get(code);
    if (!old) { lines.push(`＋ 新增國家 ${code}（${name(c)}）：${c.nodes.length} 個節點，預設 ${c.nodes[0]}`); continue; }
    const added = c.nodes.filter((h) => !old.nodes.includes(h));
    const removed = old.nodes.filter((h) => !c.nodes.includes(h));
    const sub = [];
    if (old.nodes[0] !== c.nodes[0]) sub.push(`預設 ${old.nodes[0]} → ${c.nodes[0]}`);
    if (added.length) sub.push(`加入 ${added.join("、")}`);
    if (removed.length) sub.push(`移除 ${removed.join("、")}`);
    if (!sub.length && old.nodes.join() !== c.nodes.join()) sub.push("只有順序改變");
    if (JSON.stringify(old.name) !== JSON.stringify(c.name) || old.dial !== c.dial) sub.push("名稱或區碼改變");
    if (sub.length) lines.push(`～ ${code}（${name(c)}）：${sub.join("；")}`);
  }
  for (const [code, c] of ac) if (!bc.has(code)) lines.push(`－ 移除國家 ${code}（${name(c)}）`);
  if ((a.countries || []).map((c) => c.code).join() !== (b.countries || []).map((c) => c.code).join() && lines.every((l) => !l.startsWith("＋ 新增國家") && !l.startsWith("－ 移除國家"))) lines.push("～ 國家順序改變");
  const ao = new Map((a.options || []).map((o) => [o.value, o]));
  const bo = new Map((b.options || []).map((o) => [o.value, o]));
  const oAdd = [...bo.keys()].filter((k) => !ao.has(k));
  const oDel = [...ao.keys()].filter((k) => !bo.has(k));
  const oChg = [...bo.keys()].filter((k) => ao.has(k) && JSON.stringify(ao.get(k)) !== JSON.stringify(bo.get(k)));
  const some = (xs) => xs.slice(0, 12).join("、") + (xs.length > 12 ? `…（共 ${xs.length} 個）` : "");
  if (oAdd.length) lines.push(`＋ 全部節點新增 ${oAdd.length} 個：${some(oAdd)}`);
  if (oDel.length) lines.push(`－ 全部節點移除 ${oDel.length} 個：${some(oDel)}`);
  if (oChg.length) lines.push(`～ 名稱或池類型改變：${some(oChg)}`);
  if (!oAdd.length && !oDel.length && (a.options || []).map((o) => o.value).join() !== (b.options || []).map((o) => o.value).join()) lines.push("～ 全部節點的順序改變");
  if (JSON.stringify(a.pools || {}) !== JSON.stringify(b.pools || {})) lines.push("～ 池類型的標籤改變");
  if (defaultHost(a) !== defaultHost(b)) lines.push(`！ 全域預設（OTHER 的第一個）：${defaultHost(a) || "（無）"} → ${defaultHost(b)}`);
  return lines;
}

// ---- 資料庫（歷史）----
let ready = null;
export function ensureTable() {
  ready ||= sql(`create table if not exists cdn_lists (
      version serial primary key,
      data jsonb not null,
      jws text,
      note text not null default '',
      published boolean not null default false,
      created_at timestamptz not null default now())`).catch((e) => { ready = null; throw e; });
  return ready;
}
// 已發布的版本（新 → 舊），不含 data
export async function history(limit = 30) {
  await ensureTable();
  return sql("select version, note, published, created_at from cdn_lists order by version desc limit $1", [limit]);
}
export async function getVersion(v) {
  await ensureTable();
  const rows = await sql("select version, data, jws, note, published, created_at from cdn_lists where version = $1", [v]);
  return rows[0] || null;
}

// 某一版跟它前一個已發布版本的差異（後台用）→ { version, prev, lines }
export async function diffWithPrevious(v) {
  await ensureTable();
  const [cur] = await sql("select version, data from cdn_lists where version = $1", [v]);
  if (!cur) return null;
  const [prev] = await sql("select version, data from cdn_lists where published and version < $1 order by version desc limit 1", [v]);
  return { version: cur.version, prev: prev ? prev.version : null, lines: diff(prev && prev.data, cur.data) };
}
