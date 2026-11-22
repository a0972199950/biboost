// 問卷核心 src/survey-core.js：擴充、report worker、admin 共用的流程圖（路徑、出口）、分頁、定義驗證、作答驗證。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "../src/survey-core.js";

const C = globalThis.BBSurveyCore;
import { L, opt, sampleDef } from "./helpers/survey-sample.mjs";

const ids = (list) => list.map((q) => q.id);
const pageIds = (pages) => pages.map((p) => p.map((q) => q.id));

describe("survey-core：流程圖（路徑、出口、分頁）", () => {
  test("沿著出口走：一題一頁；inline 不自成一頁；路徑尾端連續的輸入框題（含長文字、Email）併成一頁", () => {
    const pages = C.pagesOf(sampleDef(), { q_often: "never" });
    assert.deepEqual(pageIds(pages), [["q_fruit"], ["q_often"], ["q_rate"], ["q_nps"], ["q_hours"], ["q_rank"], ["q_email", "q_note"]]);
    const more = C.pagesOf(sampleDef(), { q_often: "daily", q_fruit: ["other"] });
    assert.deepEqual(more.map((p) => p[0].id), ["q_fruit", "q_often", "q_size", "q_why", "q_rate", "q_nps", "q_hours", "q_rank", "q_email"]);
  });
  test("單選：每個選項各自的出口；沒對應的選項、沒回答走其他情況", () => {
    const d = sampleDef();
    assert.deepEqual(ids(C.pathOf(d, { q_often: "weekly" })).slice(0, 4), ["q_fruit", "q_often", "q_why", "q_rate"]);
    assert.deepEqual(ids(C.pathOf(d, { q_often: "never" })).slice(0, 3), ["q_fruit", "q_often", "q_rate"]);
    assert.deepEqual(ids(C.pathOf(d, {})).slice(0, 3), ["q_fruit", "q_often", "q_rate"], "還沒回答：照其他情況算（總頁數會在回答後變）");
    assert.equal(C.nextOf(d, d.questions[2], { q_often: "daily" }), "q_size");
  });
  test("出口指到 end：路徑在這裡結束（變體裡的選項也可以當條件）", () => {
    const d = sampleDef();
    assert.deepEqual(ids(C.pathOf(d, { q_often: "daily", q_size: "y3" })), ["q_fruit", "q_often", "q_size"]);
    assert.deepEqual(ids(C.pathOf(d, { q_often: "daily", q_size: "y2" })).slice(0, 4), ["q_fruit", "q_often", "q_size", "q_why"]);
    assert.equal(C.pagesOf(d, { q_often: "daily", q_size: "y3" }).length, 3);
  });
  test("複選：由上往下比對，第一條符合的勝出（勾了 A、B 其中任一個）；都沒勾到走其他情況", () => {
    const d = {
      questions: [
        { id: "m", type: "multi", options: opt("a", "b", "c", "d"), next: { rules: [{ in: ["a", "b"], to: "x" }, { in: ["b", "c"], to: "y" }], else: "z" } },
        { id: "x", type: "text", next: { else: "end" } },
        { id: "y", type: "text", next: { else: "end" } },
        { id: "z", type: "text" },
      ],
    };
    assert.equal(C.nextOf(d, d.questions[0], { m: ["b"] }), "x", "b 兩條都符合：排上面的勝出");
    assert.equal(C.nextOf(d, d.questions[0], { m: ["c", "a"] }), "x", "跟勾的順序無關，看出口的順序");
    assert.equal(C.nextOf(d, d.questions[0], { m: ["c"] }), "y");
    assert.equal(C.nextOf(d, d.questions[0], { m: ["d"] }), "z");
    assert.equal(C.nextOf(d, d.questions[0], {}), "z");
    d.questions[0].next.rules.reverse();
    assert.equal(C.nextOf(d, d.questions[0], { m: ["b"] }), "y", "調換順序後換另一條勝出");
  });
  test("沒寫 next（或沒寫 else）：走陣列裡下一張卡片（跳過說明框），最後一張之後結束；exitsOf 展開成明確的目的地", () => {
    const d = sampleDef();
    assert.deepEqual(C.exitsOf(d, d.questions[6]), { rules: [], else: "q_hours" });
    assert.deepEqual(C.exitsOf(d, d.questions[10]), { rules: [], else: "end" });
    assert.deepEqual(C.exitsOf(d, d.questions[2]).rules.map((r) => r.to), ["q_size", "q_why"]);
    const e = { questions: [
      { id: "a", type: "single", options: opt("x", "y"), next: { rules: [{ in: ["x"], to: "c" }] } },
      { id: "a_other", type: "text", inline: true, showIf: { q: "a", in: ["y"] } },
      { id: "b", type: "text" }, { id: "c", type: "text" }] };
    assert.deepEqual(ids(C.pathOf(e, { a: "y" })), ["a", "b", "c"], "沒寫 else：下一張卡片是 b（跳過說明框 a_other）");
    assert.deepEqual(ids(C.pathOf(e, { a: "x" })), ["a", "c"]);
    assert.deepEqual(C.pathIds(e, { a: "y" }), ["a", "a_other", "b", "c"], "打開的說明框也在路徑上");
    assert.deepEqual(C.pathIds(e, { a: "x" }), ["a", "c"]);
  });
  test("只有單選、複選看 rules：其他題型就算寫了 rules 也只走其他情況", () => {
    const d = { questions: [{ id: "r", type: "rating", next: { rules: [{ in: ["5"], to: "b" }], else: "c" } }, { id: "b", type: "text" }, { id: "c", type: "text" }] };
    assert.equal(C.nextOf(d, d.questions[0], { r: 5 }), "c");
  });
  test("壞掉的出口（指回前面、指到自己、不存在、說明框）一律當成結束，一定走得完", () => {
    const mk = (to) => ({ questions: [
      { id: "a", type: "text" },
      { id: "b", type: "single", options: opt("x", "y"), next: { rules: [{ in: ["x"], to }], else: "c" } },
      { id: "b_o", type: "text", inline: true, showIf: { q: "b", in: ["y"] } },
      { id: "c", type: "text" }] });
    for (const to of ["a", "b", "nope", "b_o"]) assert.deepEqual(ids(C.pathOf(mk(to), { b: "x" })), ["a", "b"], to);
    assert.deepEqual(C.pagesOf({ questions: [] }, {}), []);
  });
  test("說明框的上游可以是單選或複選；inlineOf 找掛在某題下面的說明框", () => {
    const d = sampleDef();
    const other = d.questions[1];
    assert.equal(C.isVisible(other, { q_fruit: ["apple"] }), false);
    assert.equal(C.isVisible(other, { q_fruit: ["apple", "other"] }), true);
    assert.deepEqual(C.inlineOf(d, "q_fruit").map((q) => q.id), ["q_fruit_other"]);
    assert.equal(C.opensInline(d, d.questions[0], "other"), true);
    assert.equal(C.opensInline(d, d.questions[0], "apple"), false);
  });
  test("選項隨機排序：會打開說明框的選項固定在最後；沒設 shuffle 就照原順序", () => {
    const d = sampleDef();
    d.questions[0].shuffle = true;
    let n = 0;
    const rand = () => [0.99, 0.01][n++ % 2];
    const order = C.optionOrder(d, d.questions[0], rand);
    assert.equal(order.at(-1), "other");
    assert.deepEqual([...order].sort(), ["apple", "other", "pear"]);
    assert.deepEqual(C.optionOrder(d, d.questions[2]), ["daily", "weekly", "never"]);
  });
});

describe("survey-core：依國家下發", () => {
  test("resolve 套用該國的變體（文字或選項），拿掉 variants、audience、name、layout（後台流程圖的卡片位置）", () => {
    const d = { ...sampleDef(), name: "內部名稱", layout: { positions: { q_fruit: { x: 1, y: 2 } } } };
    const tw = C.resolve(d, "TW"), jp = C.resolve(d, "JP"), us = C.resolve(d, "US");
    assert.equal(tw.questions[2].text.en, "often (TW)?");
    assert.equal(us.questions[2].text.en, "often?");
    assert.deepEqual(jp.questions[3].options.map((o) => o.id), ["y1", "y2", "y3"]);
    assert.deepEqual(us.questions[3].options.map((o) => o.id), ["p1", "p2"]);
    assert.deepEqual(us.questions[3].next, { rules: [{ in: ["y3"], to: "end" }], else: "q_why" }, "出口照原樣下發");
    assert.equal(us.questions[2].variants, undefined);
    assert.equal(us.audience, undefined);
    assert.equal(us.name, undefined);
    assert.equal(us.layout, undefined);
    assert.equal(us.minExtVersion, C.BASE_EXT_VERSION);
    assert.deepEqual(us.triggers, { invite: true, events: ["region_blocked"] });
  });
  test("對象：中國大陸一律不給；有指定國家或語言時只給符合的", () => {
    const d = sampleDef();
    assert.equal(C.audienceMatch(d, "CN", "zh_CN"), false);
    assert.equal(C.audienceMatch(d, "SG", "en"), true);
    d.audience = { countries: ["TW", "HK"], langs: ["zh_TW"] };
    assert.equal(C.audienceMatch(d, "TW", "zh_TW"), true);
    assert.equal(C.audienceMatch(d, "TW", "en"), false);
    assert.equal(C.audienceMatch(d, "SG", "zh_TW"), false);
  });
  test("版本比較", () => {
    assert.equal(C.cmpVersion("2.10.1", "2.9.9"), 1);
    assert.equal(C.cmpVersion("2.10", "2.10.0"), 0);
    assert.equal(C.cmpVersion("2.10.0", "2.11.0"), -1);
  });
});

describe("survey-core：定義驗證", () => {
  const paths = (def, publish) => C.validateDefinition(def, { publish }).map((e) => e.path);
  test("範例問卷沒問題（發布前的完整檢查也過）", () => {
    assert.deepEqual(C.validateDefinition(sampleDef(), { publish: true }), []);
  });
  test("id、題目 id 重複、題型、選項數；題目層級的錯誤標上題目 id", () => {
    const d = sampleDef();
    d.id = "Bad ID";
    d.questions[4].id = "q_often";
    d.questions[5].type = "matrix";
    d.questions[2].options = opt("only");
    const p = paths(d);
    assert.ok(p.includes("id"));
    assert.ok(p.includes("questions.4.id"));
    assert.ok(p.includes("questions.5.type"));
    assert.ok(p.includes("questions.2.options"));
    assert.equal(C.validateDefinition(d).find((e) => e.path === "questions.5.type").q, "q_rate");
  });
  test("說明框只能是選填的短文字、要掛在前面的單選或複選題下面；只能有一題 Email", () => {
    const d = sampleDef();
    d.questions[1].type = "longtext";
    d.questions[1].required = true;
    d.questions.push({ id: "q_email2", type: "email", required: false, text: L("x") });
    const p = paths(d);
    assert.ok(p.includes("questions.1.inline"));
    assert.ok(p.includes("questions.1.required"));
    assert.ok(p.includes("questions.11"));
    const e = sampleDef();
    e.questions[1].showIf = { q: "q_rate", in: ["x"] };
    assert.ok(paths(e).includes("questions.1.showIf"));
    const f = sampleDef();
    f.questions[1].showIf = { q: "q_fruit", in: ["kiwi"] };
    assert.ok(paths(f).includes("questions.1.showIf.in"));
  });
  test("觸發：至少一種；事件要是擴充認得的", () => {
    const d = sampleDef();
    d.triggers = { invite: false, events: [] };
    assert.ok(paths(d).includes("triggers"));
    d.triggers = { invite: true, events: ["unknown_event"] };
    assert.ok(paths(d).includes("triggers.events.0"));
  });
  test("數字題要有範圍；複選上限在選項數以內；評分樣式", () => {
    const d = sampleDef();
    d.questions[7].range = { min: 5, max: 1 };
    d.questions[0].maxSelect = 9;
    d.questions[5].scale = { style: "emoji" };
    const p = paths(d);
    assert.ok(p.includes("questions.7.range"));
    assert.ok(p.includes("questions.0.maxSelect"));
    assert.ok(p.includes("questions.5.scale.style"));
  });
  test("存草稿只要有一種語言；發布前目標語言都要齊（沒設目標語言＝六語）", () => {
    const d = sampleDef();
    d.title = { zh_TW: "標題" };
    assert.deepEqual(paths(d, false), []);
    assert.ok(paths(d, true).includes("title.en"));
    d.audience.langs = ["zh_TW"];
    assert.deepEqual(paths(d, true).filter((x) => x.startsWith("title")), []);
  });
});

describe("survey-core：流程圖的檢查（存檔、發布、worker 都用）", () => {
  const msgs = (def) => C.validateDefinition(def).map((e) => `${e.path} ${e.message}`);
  const has = (def, path, re) => assert.ok(msgs(def).some((m) => m.startsWith(path + " ") && (!re || re.test(m))), `${path} ${re}\n${msgs(def).join("\n")}`);
  const mini = (questions) => ({ id: "s-m", title: L("t"), prompt: { invite: L("i") }, triggers: { invite: true }, questions });
  test("範例問卷的流程圖沒問題；checkFlow 只看流程圖", () => {
    assert.deepEqual(C.checkFlow(sampleDef()), []);
    const d = sampleDef();
    d.title = {};
    assert.deepEqual(C.checkFlow(d), [], "標題、翻譯不是流程圖的事");
  });
  test("不能繞回前面（指回前面的題目、指到自己）＝沒有環", () => {
    const d = sampleDef();
    d.questions[4].next = { else: "q_often" };
    has(d, "questions.4.next.else", /「q_why」的出口指回前面的題目「q_often」/);
    const e = sampleDef();
    e.questions[2].next.rules[0].to = "q_often";
    has(e, "questions.2.next.rules.0.to", /指回自己/);
    assert.ok(C.checkFlow(e).length > 0);
  });
  test("懸空：指到不存在的題目、說明框、沒設目的地；用到不存在的選項（預設與各國變體都沒有）", () => {
    const d = sampleDef();
    d.questions[2].next.rules[1].to = "q_gone";
    has(d, "questions.2.next.rules.1.to", /不存在的題目「q_gone」/);
    const e = sampleDef();
    e.questions[0].next = { else: "q_fruit_other" };
    has(e, "questions.0.next.else", /說明框「q_fruit_other」/);
    const f = sampleDef();
    f.questions[2].next.rules[0].in = ["sometimes"];
    has(f, "questions.2.next.rules.0.in", /不存在的選項「sometimes」/);
    const g = sampleDef();
    g.questions[3].next.rules[0].in = ["y3", "p9"];
    has(g, "questions.3.next.rules.0.in", /「p9」/);
    assert.ok(!msgs(g).some((m) => /「y3」/.test(m)), "y3 只在日本的變體裡，也算存在");
    const h = sampleDef();
    delete h.questions[2].next.rules[0].to;
    has(h, "questions.2.next.rules.0.to", /沒有設定目的地/);
  });
  test("到不了的卡片要擋，訊息說是哪一題", () => {
    const d = sampleDef();
    d.questions[2].next = { rules: [{ in: ["daily"], to: "q_size" }], else: "q_rate" }; // weekly 不再去 q_why，但 q_size 的其他情況還會到 q_why
    assert.deepEqual(C.checkFlow(d), []);
    d.questions[3].next = { else: "q_rate" };
    has(d, "questions.4", /「q_why」走不到/);
    assert.equal(C.checkFlow(d).find((e) => /走不到/.test(e.message)).q, "q_why");
  });
  test("rules 只限單選、複選；其他題型（含排序）只有一條下一題", () => {
    for (const i of [5, 6, 7, 8, 9, 10]) {
      const d = sampleDef();
      d.questions[i].next = { rules: [{ in: ["a"], to: "end" }] };
      has(d, `questions.${i}.next.rules`, /只能有一條「下一題」/);
    }
  });
  test("不會生效的出口：單選的選項重複出現、複選的選項全被上面接走；空的條件", () => {
    const d = sampleDef();
    d.questions[2].next.rules.push({ in: ["daily"], to: "q_rate" });
    has(d, "questions.2.next.rules.2.in", /已經用過/);
    const m = mini([
      { id: "m", type: "multi", text: L("m"), options: opt("a", "b", "c"), next: { rules: [{ in: ["a", "b"], to: "x" }, { in: ["b"], to: "y" }, { in: ["b", "c"], to: "y" }, { in: [], to: "y" }], else: "end" } },
      { id: "x", type: "text", text: L("x"), next: { else: "y" } }, { id: "y", type: "text", text: L("y") }]);
    has(m, "questions.0.next.rules.1.in", /永遠用不到/);
    assert.ok(!msgs(m).some((x) => x.startsWith("questions.0.next.rules.2.in ") && /永遠用不到/.test(x)), "c 沒被接走，這條會生效");
    has(m, "questions.0.next.rules.3.in", /至少一個選項/);
  });
  test("卡片不能再用 showIf；說明框不能有出口；格式錯誤；layout 要是物件", () => {
    const d = sampleDef();
    d.questions[4].showIf = { q: "q_often", in: ["weekly"] };
    has(d, "questions.4.showIf", /跳題改用流程圖的出口/);
    assert.ok(C.checkFlow(d).some((e) => e.path === "questions.4.showIf"));
    const e = sampleDef();
    e.questions[1].next = { else: "q_often" };
    has(e, "questions.1.next", /說明框「q_fruit_other」沒有出口/);
    const f = sampleDef();
    f.questions[0].next = "q_often";
    has(f, "questions.0.next", /格式錯誤/);
    const g = sampleDef();
    g.questions[2].next.rules = "daily";
    has(g, "questions.2.next.rules", /格式錯誤/);
    const h = sampleDef();
    h.layout = [];
    has(h, "layout");
    const i = sampleDef();
    i.layout = { positions: { q_fruit: { x: 0, y: 0 } } };
    assert.deepEqual(C.validateDefinition(i, { publish: true }), []);
  });
});

describe("survey-core：錯誤訊息給人看的寫法（describeError）", () => {
  const texts = (def, publish) => C.validateDefinition(def, { publish }).map((e) => C.describeError(def, e));
  test("題目用流程圖上的題號（不是陣列索引；前面有說明框也對得上）＋題目 id；選項用第幾個", () => {
    const d = sampleDef();
    d.questions[10].next = { else: "end" }; // 最後一題直接結束，新的 q1 就走不到
    d.questions.push({ id: "q1", type: "single", required: true, text: {}, options: [{ id: "a", text: {} }, { id: "b", text: {} }], next: { else: "end" } });
    const t = texts(d);
    // q1 在陣列裡是 questions.11（前面有一個說明框），在流程圖上是第 11 張卡片
    assert.ok(t.includes("第 11 題（q1）：題目文字至少要填一種語言"), t.join("\n"));
    assert.ok(t.includes("第 11 題（q1）的第 1 個選項：文字至少要填一種語言"));
    assert.ok(t.includes("第 11 題（q1）走不到：沒有任何出口連到這題"));
    assert.ok(t.every((x) => !/questions\.\d/.test(x)), "不出現陣列路徑");
  });
  test("出口的錯誤：訊息裡的題目 id 換成題號", () => {
    const d = sampleDef();
    d.questions[4].next = { else: "q_often" };
    assert.ok(texts(d).includes("第 4 題（q_why）的出口指回前面的題目第 2 題（q_often）（不能繞回去）"), texts(d).join("\n"));
  });
  test("說明框寫成「第 N 題的說明框（id）」；缺翻譯寫語言名稱；非題目的欄位用中文名", () => {
    const d = sampleDef();
    d.questions[1].next = { else: "q_often" };
    d.questions[1].text = { zh_TW: "x" };
    d.title = { zh_TW: "標題" };
    d.triggers = { invite: false, events: [] };
    const t = texts(d, true);
    assert.ok(t.includes("第 1 題的說明框（q_fruit_other）沒有出口（它畫在上游那題的卡片裡）"), t.join("\n"));
    assert.ok(t.includes("第 1 題的說明框（q_fruit_other）：缺英文的文字"));
    assert.ok(t.includes("標題：缺粵語的文字"));
    assert.ok(t.includes("觸發方式：至少要選一種觸發方式"));
  });
  test("path、message 不變（worker 與其他呼叫端照舊）", () => {
    const d = sampleDef();
    d.questions[4].next = { else: "q_often" };
    const e = C.validateDefinition(d).find((x) => x.path === "questions.4.next.else");
    assert.equal(e.message, "「q_why」的出口指回前面的題目「q_often」（不能繞回去）");
  });
});

describe("survey-core：作答驗證", () => {
  const def = (country = "US") => C.resolve(sampleDef(), country);
  const base = { q_fruit: ["apple"], q_often: "never", q_rate: 4 };
  test("各題型的合法答案；Email 抽出來不留在 answers；文字去頭尾空白", () => {
    const r = C.cleanAnswers(def(), { ...base, q_nps: 0, q_hours: 2.5, q_rank: ["c", "a", "b"], q_email: " Me@Example.com ", q_note: "  hi  " }, true);
    assert.deepEqual(r.answers, { q_fruit: ["apple"], q_often: "never", q_rate: 4, q_nps: 0, q_hours: 2.5, q_rank: ["c", "a", "b"], q_note: "hi" });
    assert.equal(r.email, "me@example.com");
  });
  test("路徑外的答案丟掉（換了一條路之後原本那條路上的答案不存、也不驗證）；說明框只在選了其他時留下", () => {
    const r = C.cleanAnswers(def(), { ...base, q_why: "taste", q_size: "p1", q_fruit_other: "kiwi" }, false);
    assert.equal(r.answers.q_why, undefined);
    assert.equal(r.answers.q_size, undefined);
    assert.equal(r.answers.q_fruit_other, undefined);
    const r2 = C.cleanAnswers(def(), { ...base, q_fruit: ["other"], q_fruit_other: "kiwi" }, false);
    assert.equal(r2.answers.q_fruit_other, "kiwi");
    const r3 = C.cleanAnswers(def(), { ...base, q_size: "not-an-option", q_why: 42 }, false);
    assert.deepEqual(Object.keys(r3.answers).sort(), ["q_fruit", "q_often", "q_rate"], "路徑外的答案就算格式不對也只是丟掉");
    const weekly = C.cleanAnswers(def(), { ...base, q_often: "weekly", q_why: "taste", q_size: "p1" }, false);
    assert.equal(weekly.answers.q_why, "taste");
    assert.equal(weekly.answers.q_size, undefined, "weekly 不經過 q_size");
  });
  test("路徑照驗證過的答案往下走：走到 end 之後的答案都丟掉", () => {
    const r = C.cleanAnswers(def("JP"), { ...base, q_often: "daily", q_size: "y3", q_why: "taste", q_rate: 5, q_note: "x" }, true);
    assert.deepEqual(r.answers, { q_fruit: ["apple"], q_often: "daily", q_size: "y3" });
  });
  test("不合法：選項不存在、超過複選上限、排序不完整、評分與推薦分數範圍、數字範圍與間隔、未知題目", () => {
    const bad = (a) => assert.throws(() => C.cleanAnswers(def(), { ...base, ...a }, false), (e) => e.code === "bad_answer", JSON.stringify(a));
    bad({ q_often: "sometimes" });
    bad({ q_fruit: ["apple", "pear", "other"] });
    bad({ q_rank: ["a", "b"] });
    bad({ q_rank: ["a", "a", "b"] });
    bad({ q_rate: 6 });
    bad({ q_rate: 3.5 });
    bad({ q_nps: 11 });
    bad({ q_hours: 41 });
    bad({ q_hours: 1.2 });
    bad({ q_unknown: 1 });
    assert.throws(() => C.cleanAnswers(def(), { ...base, q_email: "nope" }, false), (e) => e.code === "bad_email");
    assert.throws(() => C.cleanAnswers(def(), { ...base, q_fruit_other: "x".repeat(201), q_fruit: ["other"] }, false), (e) => e.code === "bad_answer");
  });
  test("各國的選項：日本版的選項在美國版不合法", () => {
    const a = { ...base, q_often: "daily", q_why: "taste", q_size: "y2" };
    assert.equal(C.cleanAnswers(def("JP"), a, false).answers.q_size, "y2");
    assert.equal(C.cleanAnswers(def("JP"), a, false).answers.q_why, "taste");
    assert.throws(() => C.cleanAnswers(def("US"), a, false), (e) => e.code === "bad_answer");
  });
  test("送出（final）時路徑上的必答題都要有答案；路徑外的必答題不要求", () => {
    assert.throws(() => C.cleanAnswers(def(), { q_fruit: ["apple"], q_often: "never" }, true), (e) => e.code === "incomplete");
    assert.throws(() => C.cleanAnswers(def(), { ...base, q_often: "daily" }, true), (e) => e.code === "incomplete", "q_size、q_why 在路徑上就要答");
    assert.throws(() => C.cleanAnswers(def(), { ...base, q_often: "daily", q_size: "p1" }, true), (e) => e.code === "incomplete", "q_size 的其他情況走到 q_why");
    assert.doesNotThrow(() => C.cleanAnswers(def(), { ...base, q_often: "daily", q_size: "p1", q_why: "taste" }, true));
    assert.doesNotThrow(() => C.cleanAnswers(def(), base, true));
    assert.doesNotThrow(() => C.cleanAnswers(def("JP"), { q_fruit: ["apple"], q_often: "daily", q_size: "y3" }, true), "y3 直接結束：後面的必答題（q_why、q_rate）不在路徑上");
  });
  test("自動附帶的欄位：入口包含事件名稱", () => {
    const c = { browser: "chrome", ext_version: "2.11.0", lang: "zh_HK", install_days: "lt7", custom_nodes: true };
    assert.deepEqual(C.cleanClient("region_blocked", c), { entry: "region_blocked", browser: "chrome", ext_version: "2.11.0", lang: "zh_HK", install_days: "lt7", custom_nodes: 1 });
    assert.throws(() => C.cleanClient("context", c), (e) => e.code === "bad_entry");
    assert.throws(() => C.cleanClient("invite", { ...c, lang: "fr" }), (e) => e.code === "bad_client");
  });
});

describe("survey-core：Email 格式", () => {
  test("isEmail：畫面送出前用，跟伺服器同一條規則", () => {
    assert.equal(C.isEmail("a@b.co"), true);
    assert.equal(C.isEmail("  a@b.co  "), true);
    assert.equal(C.isEmail("not-an-email"), false);
    assert.equal(C.isEmail("a@b"), false);
    assert.equal(C.isEmail(""), false);
    assert.equal(C.isEmail("a@" + "b".repeat(260) + ".com"), false);
  });
});

describe("survey-core：國家變體不能重複", () => {
  test("同一題裡同一個國家只能在一組變體（resolve 只套第一組）；不同題可以重複；同一組裡寫兩次不算", () => {
    const d = sampleDef();
    d.questions[3].variants = [
      { countries: ["JP"], options: opt("y1", "y2", "y3") },
      { countries: ["HK", "MO"], text: L("hk") },
      { countries: ["SG", "MO"], text: L("sg") },
    ];
    const errs = C.validateDefinition(d, { publish: true });
    assert.deepEqual(errs.map((e) => e.path), ["questions.3.variants"]);
    assert.equal(C.describeError(d, errs[0]), "第 3 題（q_size）：國家 MO 同時在第 2 個和第 3 個國家變體裡，只能放一組");
    d.questions[3].variants[2].countries = ["SG", "SG"];
    d.questions[2].variants = [{ countries: ["JP"], text: L("jp") }]; // 別題也有 JP：可以
    assert.deepEqual(C.validateDefinition(d, { publish: true }), []);
  });
});

describe("survey-core：resolve 下發的選項", () => {
  test("選項只下發 id、text；後台自己用的其他欄位不下發，原始定義不被改到", () => {
    const d = sampleDef();
    d.questions[3].options = d.questions[3].options.map((o, i) => ({ ...o, note: "n" + i, extra: { a: 1 } }));
    for (const o of C.resolve(d, "US").questions[3].options) assert.deepEqual(Object.keys(o).sort(), ["id", "text"]);
    assert.equal(d.questions[3].options[0].note, "n0", "原始定義不被改到");
    assert.deepEqual(C.validateDefinition(d, { publish: true }), [], "多的欄位不影響驗證");
  });
});
