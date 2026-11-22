// 問卷管理的命令列版本（後台的「問卷」頁做一樣的事）。一定要指定環境，避免不小心動到正式環境：
//   node scripts/surveys.mjs <指令> --env staging|prod
//     schema                  建資料表（已經有就略過、補欄位）
//     list                    列出問卷與狀態
//     show <id>               印出問卷（JSON）
//     import <檔案.json>       把 { id, name, def, startsAt, endsAt, maxResponses } 存成草稿（已有同 id 的草稿就覆蓋）
//     publish <id>            發布（內容鎖住，之後只能停止）
//     stop <id>               停止（關掉入口；在填的人照樣能送出）
//     copy-to <id> <環境>      複製到另一個環境，成為那邊的草稿
//     migrate-flow [id] [--dry] 一次性：把舊的跳題（showIf）轉成流程圖的出口（next），連已發布的也轉。
//                             每份都先比對新舊路徑（列舉或抽樣答案組合），不等價就整批停下、什麼都不寫；--dry 只印出前後差異
// 問卷內容（題目、選項）不放進 repo：要匯入的 JSON 放在 repo 外面。
import fs from "node:fs";
import { withDb } from "./lib/lotteries.mjs";
import * as S from "./lib/surveys.mjs";
import { useExitFlush } from "./lib/kv-snapshot.mjs";
import { convertShowIf, checkEquivalent, needsMigration } from "./lib/survey-flow-migrate.mjs";

// 改到公告、抽獎、功能開關、問卷這些表時，結束前把給擴充讀的 KV 快照重寫（scripts/lib/kv-snapshot.mjs）
useExitFlush();

const args = process.argv.slice(2);
const i = args.indexOf("--env");
const env = i >= 0 ? args[i + 1] : null;
const dry = args.includes("--dry");
const [cmd, a1, a2] = args.filter((x, j) => j !== i && j !== i + 1 && x !== "--dry");
if (env !== "staging" && env !== "prod") {
  console.error("要指定環境：--env staging 或 --env prod");
  process.exit(2);
}

const show = (s) => console.log(`${s.id}\t${s.state}${s.reason ? `(${s.reason})` : ""}\t完成 ${s.completed}${s.maxResponses ? "/" + s.maxResponses : ""}\t${s.name}`);
try {
  await withDb(env, async () => {
    if (cmd === "schema") { await S.ensureSurveyTables(); console.log(`${env}：資料表已就緒`); }
    else if (cmd === "list") (await S.listSurveys()).forEach(show);
    else if (cmd === "show") console.log(JSON.stringify(await S.getSurvey(a1), null, 2));
    else if (cmd === "import") show(await S.saveDraft(JSON.parse(fs.readFileSync(a1, "utf8"))));
    else if (cmd === "publish") show(await S.publishSurvey(a1));
    else if (cmd === "stop") show(await S.stopSurvey(a1));
    else if (cmd === "copy-to") show(await S.copyToEnv(a1, a2));
    else if (cmd === "migrate-flow") await migrateFlow(a1);
    else { console.error("指令：schema | list | show <id> | import <檔案> | publish <id> | stop <id> | copy-to <id> <環境> | migrate-flow [id] [--dry]"); process.exitCode = 2; }
  });
} catch (e) {
  console.error(e.message);
  if (e.details) e.details.forEach((d) => console.error(`  ${d.text || `${d.path}：${d.message}`}`));
  process.exitCode = 1;
}

// 每張卡片轉換前後的跳題設定（給人對照）
function flowLines(def) {
  return (def.questions || []).map((q) => {
    if (q.inline) return `    ${q.id}（說明框）showIf ${JSON.stringify(q.showIf)}`;
    const parts = [];
    if (q.showIf) parts.push(`showIf ${JSON.stringify(q.showIf)}`);
    if (q.next) parts.push(`next ${JSON.stringify(q.next)}`);
    return `    ${q.id}（${q.type}）${parts.join("  ") || "（照順序）"}`;
  });
}
async function migrateFlow(only) {
  const list = (await S.listSurveys()).filter((s) => !only || s.id === only);
  if (only && !list.length) throw new Error(`找不到問卷 ${only}`);
  const plan = [];
  for (const s of list) {
    const oldDef = { ...s.def, id: s.id };
    if (!needsMigration(oldDef)) { console.log(`${s.id}：已經是流程圖格式，略過`); continue; }
    const r = convertShowIf(oldDef);
    if (r.error) throw new Error(`${s.id}：${r.error}（整批停下，沒有寫入任何一份）`);
    const eq = checkEquivalent(oldDef, r.def);
    console.log(`
== ${s.id}（${s.status}／${s.state}）`);
    console.log("  轉換前：");
    flowLines(oldDef).forEach((l) => console.log(l));
    console.log("  轉換後：");
    flowLines(r.def).forEach((l) => console.log(l));
    console.log(`  等價檢查：${eq.ok ? "一樣" : "不一樣"}，答案組合 ${eq.total} 種，${eq.sampled ? `抽樣比對 ${eq.checked} 種` : `全部比對 ${eq.checked} 種`}`);
    if (!eq.ok) {
      console.log(`  不一樣的例子：答案 ${JSON.stringify(eq.mismatch.answers)}`);
      console.log(`    舊：${eq.mismatch.legacy.join(" → ")}`);
      console.log(`    新：${eq.mismatch.flow.join(" → ")}`);
      throw new Error(`${s.id}：轉換前後的路徑不一樣（整批停下，沒有寫入任何一份）`);
    }
    plan.push({ id: s.id, oldDef: s.def, newDef: r.def });
  }
  if (dry) { console.log(`
--dry：${plan.length} 份可以轉換，沒有寫入`); return; }
  for (const p of plan) {
    await S.writeMigratedDef(p.id, p.oldDef, p.newDef);
    console.log(`${p.id}：已寫入`);
  }
  console.log(`
${env}：轉換了 ${plan.length} 份`);
}
