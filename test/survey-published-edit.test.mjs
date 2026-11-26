// 問卷核心 src/survey-core.js 的 lockedChanges：已發布的問卷只能改文字與基本設定，結構（題目、選項、出口……）一律不能改
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "../src/survey-core.js";

const C = globalThis.BBSurveyCore;
import { L, opt, sampleDef } from "./helpers/survey-sample.mjs";

const q = (d, id) => d.questions.find((x) => x.id === id);
// 改一份 sampleDef，回傳 lockedChanges 的結果
const edit = (change, opts) => {
  const before = sampleDef(), after = sampleDef();
  change(after);
  return C.lockedChanges(before, after, opts);
};
const paths = (list) => list.map((e) => e.path);

describe("survey-core：發布後可以改的（lockedChanges 回空陣列）", () => {
  const allowed = {
    "標題": (d) => { d.title.en = "New title"; },
    "邀請文字": (d) => { d.prompt.invite.ja = "新しい"; },
    "事件的說明文字（新增一種語言、刪掉一種語言）": (d) => { delete d.prompt.region_blocked.ko; d.prompt.region_blocked.en = "x"; },
    "題目文字": (d) => { q(d, "q_often").text.zh_TW = "多常？"; },
    "選項文字": (d) => { q(d, "q_fruit").options[1].text.en = "Pear!"; },
    "說明框的文字": (d) => { q(d, "q_fruit_other").text.en = "Which one?"; },
    "評分兩端的說明（從沒有變成有）": (d) => { q(d, "q_rate").scale.labels = { low: L("bad"), high: L("good") }; },
    "推薦分數兩端的說明": (d) => { q(d, "q_nps").labels = { low: L("no"), high: L("yes") }; },
    "數字題的單位": (d) => { q(d, "q_hours").range.unit = L("hours"); },
    "變體的題目文字": (d) => { q(d, "q_often").variants[0].text.zh_TW = "台灣：多常？"; },
    "變體開關「換題目文字」": (d) => { q(d, "q_size").variants[0].text = L("size (JP)?"); delete q(d, "q_often").variants[0].text; },
    "變體選項的文字": (d) => { q(d, "q_size").variants[0].options[2].text.ja = "大"; },
    "頁面邀請的開關": (d) => { d.triggers.invite = false; },
    "事件觸發": (d) => { d.triggers.events = []; },
    "國家": (d) => { d.audience.countries = ["TW", "JP"]; },
    "語言": (d) => { d.audience.langs = ["zh_TW", "en"]; },
    "權重": (d) => { d.weight = 3; },
    "內部名稱": (d) => { d.name = "renamed"; },
    "修改紀錄（伺服器自己維護，不比）": (d) => { d.revisions = [{ at: 1, changes: [] }]; },
    "出口意思一樣：沒寫 else 改成寫明下一題": (d) => { q(d, "q_nps").next = { else: "q_hours" }; },
    "出口意思一樣：非單選複選的 rules: [] 拿掉": (d) => { q(d, "q_rate").next = { rules: [], else: "q_nps" }; },
    "值是 undefined 的欄位當成沒有": (d) => { q(d, "q_why").shuffle = undefined; },
  };
  for (const [name, change] of Object.entries(allowed)) {
    test(name, () => assert.deepEqual(edit(change), []));
  }
  test("一次改很多文字與基本設定", () => {
    assert.deepEqual(edit((d) => { for (const change of Object.values(allowed)) change(d); }), []);
  });
  test("沒改：空陣列", () => assert.deepEqual(C.lockedChanges(sampleDef(), sampleDef()), []));
});

describe("survey-core：發布後不能改的結構（lockedChanges 擋下）", () => {
  const locked = {
    "新增題目": [(d) => { d.questions.push({ id: "q_new", type: "text", text: L("new") }); }, ["questions"]],
    "刪除題目": [(d) => { d.questions.pop(); }, ["questions"]],
    "題目換順序": [(d) => { const [x] = d.questions.splice(4, 1); d.questions.splice(5, 0, x); }, ["questions"]],
    "改題目 id": [(d) => { q(d, "q_why").id = "q_reason"; }, ["questions"]],
    "改題型": [(d) => { q(d, "q_why").type = "multi"; }, ["questions.4.type"]],
    "改必答": [(d) => { q(d, "q_why").required = false; }, ["questions.4.required"]],
    "新增選項": [(d) => { q(d, "q_why").options.push({ id: "price", text: L("price") }); }, ["questions.4.options"]],
    "刪除選項": [(d) => { q(d, "q_fruit").options.splice(1, 1); }, ["questions.0.options"]],
    "選項換順序": [(d) => { q(d, "q_why").options.reverse(); }, ["questions.4.options"]],
    "改選項 id": [(d) => { q(d, "q_why").options[0].id = "flavor"; }, ["questions.4.options"]],
    "選項的其他欄位（沒有分類過的欄位）": [(d) => { q(d, "q_why").options[0].extra = 5; }, ["questions.4.options.0.extra"]],
    "改出口的目的地": [(d) => { q(d, "q_often").next.rules[1].to = "q_rate"; }, ["questions.2.next"]],
    "改出口的條件": [(d) => { q(d, "q_often").next.rules[0].in = ["daily", "never"]; }, ["questions.2.next"]],
    "出口的順序": [(d) => { q(d, "q_often").next.rules.reverse(); }, ["questions.2.next"]],
    "拿掉出口（改成走下一張）": [(d) => { delete q(d, "q_why").next; q(d, "q_why").next = { else: "q_rate" }; q(d, "q_rate").next = { else: "q_hours" }; }, ["questions.5.next"]],
    "說明框的條件（showIf）": [(d) => { q(d, "q_fruit_other").showIf.in = ["apple"]; }, ["questions.1.showIf"]],
    "說明框變成卡片": [(d) => { delete q(d, "q_fruit_other").inline; }, ["questions.1.inline"]],
    "隨機排序": [(d) => { q(d, "q_rank").shuffle = false; }, ["questions.8.shuffle"]],
    "最多選幾個": [(d) => { q(d, "q_fruit").maxSelect = 3; }, ["questions.0.maxSelect"]],
    "字數上限": [(d) => { q(d, "q_fruit_other").maxLength = 100; }, ["questions.1.maxLength"]],
    "數字範圍": [(d) => { q(d, "q_hours").range.max = 50; }, ["questions.7.range.max"]],
    "數字間隔": [(d) => { q(d, "q_hours").range.step = 1; }, ["questions.7.range.step"]],
    "評分的樣式": [(d) => { q(d, "q_rate").scale.style = "number"; }, ["questions.5.scale.style"]],
    "變體的國家": [(d) => { q(d, "q_often").variants[0].countries = ["TW", "HK"]; }, ["questions.2.variants.0.countries"]],
    "新增變體": [(d) => { q(d, "q_why").variants = [{ countries: ["JP"], text: L("why (JP)?") }]; }, ["questions.4.variants"]],
    "刪除變體": [(d) => { q(d, "q_often").variants = []; }, ["questions.2.variants"]],
    "變體開關「換選項」": [(d) => { q(d, "q_often").variants[0].options = opt("daily", "weekly", "never"); }, ["questions.2.variants.0.options"]],
    "變體選項換順序": [(d) => { q(d, "q_size").variants[0].options.reverse(); }, ["questions.3.variants.0.options"]],
    "變體選項的數目": [(d) => { q(d, "q_size").variants[0].options.pop(); }, ["questions.3.variants.0.options"]],
    "流程圖的版面": [(d) => { d.layout = { positions: { q_fruit: { x: 1, y: 2 } } }; }, ["layout"]],
    "問卷 id": [(d) => { d.id = "other-survey"; }, ["id"]],
    "沒分類的新欄位（最上層）": [(d) => { d.audienceFilter = { minVersion: "3" }; }, ["audienceFilter"]],
    "沒分類的新欄位（題目）": [(d) => { q(d, "q_why").hint = L("hint"); }, ["questions.4.hint"]],
    "沒分類的新欄位（選項）": [(d) => { q(d, "q_why").options[0].image = "x.png"; }, ["questions.4.options.0.image"]],
    "沒分類的新欄位（觸發、對象、說明文字）": [(d) => { d.triggers.delay = 5; d.audience.browsers = ["chrome"]; d.prompt.newEvent = L("x"); }, ["prompt.newEvent", "triggers.delay", "audience.browsers"]],
    "文字的位置放了不是文字的東西": [(d) => { q(d, "q_why").text = "plain"; }, ["questions.4.text"]],
  };
  for (const [name, [change, expected]] of Object.entries(locked)) {
    test(name, () => assert.deepEqual(paths(edit(change)).sort(), expected.slice().sort()));
  }
  test("擋下的地方帶題目 id，describeError 轉得出給人看的一句話", () => {
    const after = sampleDef();
    q(after, "q_why").type = "multi";
    q(after, "q_why").options.reverse();
    const errs = C.lockedChanges(sampleDef(), after);
    assert.deepEqual(errs.map((e) => e.q), ["q_why", "q_why"]);
    assert.deepEqual(errs.map((e) => C.describeError(after, e)), [
      "第 4 題（q_why）：題型發布後不能改",
      "第 4 題（q_why）：發布後不能新增、刪除選項，或改選項的 id、順序",
    ]);
    const more = sampleDef();
    more.questions.pop();
    assert.deepEqual(C.lockedChanges(sampleDef(), more).map((e) => C.describeError(more, e)), ["題目：發布後不能新增、刪除題目，或改題目的 id、順序"]);
  });
  test("格式錯誤的定義：整份擋下", () => {
    assert.deepEqual(paths(C.lockedChanges(sampleDef(), null)), [""]);
    assert.deepEqual(paths(C.lockedChanges(sampleDef(), { ...sampleDef(), questions: "x" })), ["questions"]);
  });
});

describe("survey-core：已結束的問卷只能改文字（textOnly）", () => {
  test("文字與內部名稱照樣可以改", () => {
    assert.deepEqual(edit((d) => { d.title.en = "x"; q(d, "q_why").options[0].text.en = "y"; d.name = "z"; }, { textOnly: true }), []);
  });
  test("觸發、國家、語言、權重都不能改", () => {
    const errs = edit((d) => {
      d.triggers.invite = false;
      d.triggers.events = [];
      d.audience.countries = ["TW"];
      d.audience.langs = ["en"];
      d.weight = 2;
    }, { textOnly: true });
    assert.deepEqual(paths(errs), ["triggers.invite", "triggers.events", "audience.countries", "audience.langs", "weight"]);
    assert.ok(errs.every((e) => e.message === "已結束的問卷只能改文字"));
  });
});

describe("survey-core：修改紀錄不下發", () => {
  test("resolve() 不帶 revisions，也不帶 layout、audience、name", () => {
    const d = { ...sampleDef(), name: "internal", layout: { positions: {} }, revisions: [{ at: 1, changes: [{ path: "title.en", before: "a", after: "b" }] }] };
    const out = C.resolve(d, "TW");
    assert.deepEqual(Object.keys(out).sort(), ["id", "minExtVersion", "prompt", "questions", "title", "triggers", "weight"]);
    assert.ok(!JSON.stringify(out).includes("revisions"));
  });
});
