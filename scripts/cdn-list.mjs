// 節點清單（伺服器下發）的命令列工具。說明見 scripts/lib/cdn-list.mjs。
//   npm run cdn-list:pull                     線上版本 → .cdn-list/cdn-list.json（本機工作檔，gitignored；分析、編輯都用這份）
//   npm run cdn-list:diff                     工作檔跟線上版本差在哪（不上傳）
//   npm run cdn-list:publish -- --note "…"    檢查 → 顯示差異 → 加 --yes 才真的發布（沒加只列差異就結束）
//   npm run cdn-list:rollback -- <版本> --yes  把某一版重新發布成新的版本（退回）
//   npm run cdn-list:history                  發布紀錄
//   npm run cdn-list:status                   兩個來源目前各是第幾版
// 選項：--file <路徑> 改用別的工作檔
import path from "node:path";
import {
  WORK_FILE, CdnListError, fetchLive, readWorkFile, writeWorkFile, validate, diff, publish, verifyLive, history, getVersion, extModule,
} from "./lib/cdn-list.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = opt("file") ? path.resolve(opt("file")) : WORK_FILE;

async function liveOrNull() {
  try { return await fetchLive(); } catch (e) { console.log(`（${e.message.split("\n")[0]}）`); return null; }
}
function printDiff(lines) {
  if (!lines.length) console.log("跟線上版本沒有差異。");
  else lines.forEach((l) => console.log("  " + l));
}

async function main() {
  if (cmd === "pull") {
    const live = await fetchLive();
    writeWorkFile(live.data, file);
    console.log(`第 ${live.v} 版（${live.source}）→ ${path.relative(process.cwd(), file)}`);
    return;
  }
  if (cmd === "diff" || cmd === "publish") {
    const data = readWorkFile(file);
    const errs = validate(data);
    if (errs.length) throw new CdnListError("沒通過檢查：\n  " + errs.join("\n  "));
    const live = await liveOrNull();
    console.log(live ? `跟線上第 ${live.v} 版比較：` : "線上還沒有任何版本（第一次發布）：");
    const lines = diff(live && live.data, data);
    printDiff(lines);
    if (cmd === "diff") return;
    if (live && !lines.length && !flag("force")) { console.log("沒有差異，不發布（真的要發就加 --force）。"); return; }
    if (!flag("yes")) { console.log("\n確認沒問題後加 --yes 再跑一次就會發布。"); return; }
    const { version } = await publish(data, { note: opt("note") || "" });
    await verifyLive(version);
    return;
  }
  if (cmd === "rollback") {
    const v = Number(argv[1]);
    if (!Number.isInteger(v) || v < 1) throw new CdnListError("用法：npm run cdn-list:rollback -- <版本> --yes");
    const row = await getVersion(v);
    if (!row || !row.published) throw new CdnListError(`找不到已發布的第 ${v} 版`);
    const live = await liveOrNull();
    console.log(`退回第 ${v} 版（${row.note || "無備註"}）；跟線上${live ? `第 ${live.v} 版` : ""}比較：`);
    printDiff(diff(live && live.data, row.data));
    if (!flag("yes")) { console.log("\n確認後加 --yes 再跑一次。"); return; }
    const { version } = await publish(row.data, { note: `退回第 ${v} 版` + (opt("note") ? `：${opt("note")}` : "") });
    await verifyLive(version);
    return;
  }
  if (cmd === "history") {
    const rows = await history(Number(opt("limit")) || 30);
    if (!rows.length) { console.log("還沒有發布紀錄。"); return; }
    for (const r of rows) console.log(`第 ${String(r.version).padStart(3)} 版  ${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC  ${r.published ? "" : "（沒有上線）"}${r.note}`);
    return;
  }
  if (cmd === "status") {
    for (const base of extModule().SOURCES) {
      try { const l = await fetchLive({ sources: [base] }); console.log(`${base}  第 ${l.v} 版`); }
      catch (e) { console.log(`${base}  ✗ ${e.message.split("\n").pop().trim()}`); }
    }
    return;
  }
  console.log("用法：pull | diff | publish [--note …] [--yes] | rollback <版本> [--yes] | history | status（見檔案開頭）");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof CdnListError ? e.message : e);
  process.exitCode = 1;
});
