// 問卷測試用的範例問卷（跟產品無關的通用內容；真實題目只在資料庫）
// 流程圖：q_fruit → q_often ─ daily → q_size ─ y3（只有日本版有）→ 結束
//                           │                   └ 其他 → q_why → q_rate → …
//                           ├ weekly → q_why
//                           └ 其他（never、沒回答）→ q_rate → q_nps → q_hours → q_rank → q_email → q_note
// q_nps 之後的卡片沒寫 next（照陣列順序），測預設的出口
export const L = (s) => ({ zh_TW: s, zh_HK: s, zh_CN: s, en: s, ja: s, ko: s });
export const opt = (...ids) => ids.map((id) => ({ id, text: L(id) }));
export function sampleDef() {
  return {
    id: "sample-survey",
    title: L("TITLE"),
    prompt: { invite: L("INVITE"), region_blocked: L("EVENT") },
    triggers: { invite: true, events: ["region_blocked"] },
    audience: { countries: [], langs: [] },
    weight: 1,
    questions: [
      { id: "q_fruit", type: "multi", required: true, text: L("fruit?"), options: opt("apple", "pear", "other"), maxSelect: 2, next: { else: "q_often" } },
      { id: "q_fruit_other", type: "text", required: false, inline: true, showIf: { q: "q_fruit", in: ["other"] }, text: L("which?"), maxLength: 200 },
      { id: "q_often", type: "single", required: true, text: L("often?"), options: opt("daily", "weekly", "never"),
        variants: [{ countries: ["TW"], text: L("often (TW)?") }],
        next: { rules: [{ in: ["daily"], to: "q_size" }, { in: ["weekly"], to: "q_why" }], else: "q_rate" } },
      { id: "q_size", type: "single", required: true, text: L("size?"), options: opt("p1", "p2"),
        variants: [{ countries: ["JP"], options: opt("y1", "y2", "y3") }],
        next: { rules: [{ in: ["y3"], to: "end" }], else: "q_why" } },
      { id: "q_why", type: "single", required: true, text: L("why?"), options: opt("taste", "health"), next: { else: "q_rate" } },
      { id: "q_rate", type: "rating", required: true, text: L("rate?"), scale: { style: "star" }, next: { else: "q_nps" } },
      { id: "q_nps", type: "nps", required: false, text: L("nps?") },
      { id: "q_hours", type: "number", required: false, text: L("hours?"), range: { min: 0, max: 40, step: 0.5 } },
      { id: "q_rank", type: "rank", required: false, text: L("rank?"), options: opt("a", "b", "c"), shuffle: true },
      { id: "q_email", type: "email", required: false, text: L("email?") },
      { id: "q_note", type: "longtext", required: false, text: L("note?") },
    ],
  };
}
