// 公告的命令列版本（後台的「公告」頁做新增、編輯、刪除；這支做上線用的 schema 與清掉舊的自動抽獎公告）。一定要指定環境：
//   node scripts/announcements.mjs <指令> --env staging|prod
//     schema                    公告改版（2026-11-21）的欄位與類型（survey_id、starts_at、ends_at、type 加 survey）；已經有就略過
//     list                      列出公告：id、類型、期間、連結的抽獎／問卷、新版擴充現在會不會顯示
//     delete-legacy [--dry]     刪掉改版前自動建的抽獎公告（沒有自己的標題與期間）；--dry 只列出會刪哪些
// 刪除與 schema 都會改到公告：結束前自動重寫給擴充讀的 KV 快照（useExitFlush）。
import { withDb } from "./lib/lotteries.mjs";
import * as A from "./lib/announcements.mjs";
import { useExitFlush } from "./lib/kv-snapshot.mjs";

// 改到公告、抽獎、功能開關、問卷這些表時，結束前把給擴充讀的 KV 快照重寫（scripts/lib/kv-snapshot.mjs）
useExitFlush();

const args = process.argv.slice(2);
const i = args.indexOf("--env");
const env = i >= 0 ? args[i + 1] : null;
const dry = args.includes("--dry");
const [cmd] = args.filter((x, j) => j !== i && j !== i + 1 && x !== "--dry");
if (env !== "staging" && env !== "prod") {
  console.error("要指定環境：--env staging 或 --env prod");
  process.exit(2);
}

const tw = (t) => (t == null ? "不限" : new Date(t).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }));
const pick = (m) => (m && (m["zh-TW"] || Object.values(m)[0])) || "";
function line(a) {
  const target = a.type === "lottery" ? `抽獎 ${a.lotteryId}（${a.lotteryStatus || "?"}）${a.legacy ? " 舊的自動公告" : ""}`
    : a.type === "survey" ? `問卷 ${a.surveyId}（${a.surveyState}）` : "";
  return `#${a.id}\t${a.type}\t${a.visible ? "顯示中" : "不顯示"}\t${tw(a.startsAt)} ～ ${tw(a.endsAt)}\t${(a.countries || []).join(",") || "全部"}\t${target}\t${pick(a.prefix)}${pick(a.title)}`;
}

try {
  await withDb(env, async () => {
    if (cmd === "schema") { await A.ensureAnnouncementSchema(); console.log(`${env}：公告的欄位已就緒`); }
    else if (cmd === "list") (await A.listAnnouncements()).forEach((a) => console.log(line(a)));
    else if (cmd === "delete-legacy") {
      const rows = await A.listLegacyLotteryAnnouncements();
      if (!rows.length) { console.log(`${env}：沒有舊的自動抽獎公告`); return; }
      rows.forEach((a) => console.log((dry ? "會刪 " : "刪除 ") + line(a)));
      if (dry) { console.log(`（--dry：沒有刪，共 ${rows.length} 則）`); return; }
      const gone = await A.deleteLegacyLotteryAnnouncements(rows.map((a) => a.id));
      console.log(`${env}：已刪除 ${gone.length} 則（${gone.join("、")}）`);
    } else { console.error("指令：schema | list | delete-legacy [--dry]"); process.exitCode = 2; }
  });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
