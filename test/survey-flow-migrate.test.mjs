// 跳題的一次性轉換 scripts/lib/survey-flow-migrate.mjs：舊的 showIf → 流程圖的出口 next，以及轉換前後的等價檢查。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { convertShowIf, checkEquivalent, needsMigration, legacyVisibleIds, answerCombos } from "../scripts/lib/survey-flow-migrate.mjs";
import { L, opt } from "./helpers/survey-sample.mjs";

const C = globalThis.BBSurveyCore;
const base = (questions) => ({ id: "legacy", title: L("t"), prompt: { invite: L("i") }, triggers: { invite: true, events: [] }, questions });
// 舊格式：上游單選選了某些選項，後面兩題才出現；複選勾了 other 出現說明框；國家變體有自己的選項
function legacyDef() {
  return base([
    { id: "q_dev", type: "multi", required: true, showIf: null, text: L("dev"), options: opt("pc", "phone") },
    { id: "q_freq", type: "single", required: true, showIf: null, text: L("freq"), options: opt("often", "sometimes", "rarely") },
    { id: "q_what", type: "multi", required: true, showIf: { q: "q_freq", in: ["often", "sometimes"] }, text: L("what"), options: opt("a", "b", "other"),
      variants: [{ countries: ["TW"], options: opt("a", "tw_only", "other") }] },
    { id: "q_what_other", type: "text", required: false, inline: true, showIf: { q: "q_what", in: ["other", "tw_only"] }, text: L("other") },
    { id: "q_how", type: "single", required: true, showIf: { q: "q_freq", in: ["often", "sometimes"] }, text: L("how"), options: opt("x", "y") },
    { id: "q_a", type: "single", required: true, showIf: null, text: L("a"), options: opt("yes", "no", "maybe") },
    { id: "q_b", type: "single", required: true, showIf: { q: "q_a", in: ["yes", "maybe"] }, text: L("b"), options: opt("p1", "p2") },
    { id: "q_email", type: "email", required: false, showIf: null, text: L("email") },
    { id: "q_note", type: "longtext", required: false, showIf: null, text: L("note") },
  ]);
}

describe("survey-flow-migrate：showIf → next", () => {
  test("單選的跳題轉成出口；後面同條件的題目接在分岔裡；說明框保留 showIf；卡片拿掉 showIf", () => {
    const r = convertShowIf(legacyDef());
    assert.equal(r.error, undefined, r.error);
    const q = Object.fromEntries(r.def.questions.map((x) => [x.id, x]));
    assert.deepEqual(q.q_dev.next, { else: "q_freq" });
    assert.deepEqual(q.q_freq.next, { rules: [{ in: ["often", "sometimes"], to: "q_what" }], else: "q_a" });
    assert.deepEqual(q.q_what.next, { else: "q_how" }, "走到 q_what 時 q_freq 一定是 often／sometimes，所以 q_how 一定出現");
    assert.deepEqual(q.q_how.next, { else: "q_a" });
    assert.deepEqual(q.q_a.next, { rules: [{ in: ["yes", "maybe"], to: "q_b" }], else: "q_email" });
    assert.deepEqual(q.q_note.next, { else: "end" });
    assert.deepEqual(q.q_what_other.showIf, { q: "q_what", in: ["other", "tw_only"] });
    assert.equal(q.q_what_other.next, undefined);
    assert.ok(r.def.questions.filter((x) => !x.inline).every((x) => !("showIf" in x)));
    assert.deepEqual(C.validateDefinition(r.def, { publish: true }), []);
  });
  test("等價：全部答案組合（含變體的選項、說明框）新舊路徑一樣", () => {
    const old = legacyDef();
    const r = convertShowIf(old);
    const eq = checkEquivalent(old, r.def);
    assert.equal(eq.ok, true, JSON.stringify(eq.mismatch));
    assert.equal(eq.sampled, false);
    // 條件題：q_freq（沒回答＋3）× q_what（a、b、other、tw_only 的子集合 16）× q_a（沒回答＋3）
    assert.equal(eq.total, 4 * 16 * 4);
    assert.equal(eq.checked, eq.total);
  });
  test("轉換後的路徑實際走一遍：rarely 跳過 q_what、q_how；說明框跟著上游", () => {
    const r = convertShowIf(legacyDef());
    assert.deepEqual(C.pathIds(r.def, { q_freq: "rarely", q_a: "no" }), ["q_dev", "q_freq", "q_a", "q_email", "q_note"]);
    assert.deepEqual(C.pathIds(r.def, { q_freq: "often", q_what: ["tw_only"], q_a: "yes" }),
      ["q_dev", "q_freq", "q_what", "q_what_other", "q_how", "q_a", "q_b", "q_email", "q_note"]);
    assert.deepEqual(legacyVisibleIds(legacyDef(), { q_freq: "often", q_what: ["tw_only"], q_a: "yes" }),
      ["q_dev", "q_freq", "q_what", "q_what_other", "q_how", "q_a", "q_b", "q_email", "q_note"]);
  });
  test("複選上游：各題的條件依陣列順序寫成出口（第一條符合的勝出）", () => {
    const old = base([
      { id: "m", type: "multi", text: L("m"), options: opt("a", "b", "c") },
      { id: "x", type: "text", showIf: { q: "m", in: ["a", "b"] }, text: L("x"), next: undefined },
      { id: "z", type: "text", text: L("z") },
    ]);
    const r = convertShowIf(old);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.def.questions[0].next, { rules: [{ in: ["a", "b"], to: "x" }], else: "z" });
    assert.equal(checkEquivalent(old, r.def).ok, true);
  });
  test("轉換不了就回錯誤（不寫）：條件引用了更前面的題目（新的出口只能看這一題自己的答案）", () => {
    const old = base([
      { id: "q_often", type: "single", text: L("o"), options: opt("daily", "never") },
      { id: "q_rate", type: "rating", text: L("r") },
      { id: "q_size", type: "single", showIf: { q: "q_often", in: ["daily"] }, text: L("p"), options: opt("p1", "p2") },
      { id: "q_end", type: "text", text: L("e") },
    ]);
    const r = convertShowIf(old);
    assert.match(r.error, /「q_rate」轉換不了/);
    // 複選勾了兩個選項時兩題都出現：x 之後要不要去 y 看的是 m 的答案，不是 x 的
    const m = base([
      { id: "m", type: "multi", text: L("m"), options: opt("a", "b") },
      { id: "x", type: "text", showIf: { q: "m", in: ["a"] }, text: L("x") },
      { id: "y", type: "text", showIf: { q: "m", in: ["b"] }, text: L("y") },
    ]);
    assert.match(convertShowIf(m).error, /「x」轉換不了/);
  });
  test("舊版就走不到的題目：回錯誤", () => {
    const old = base([
      { id: "a", type: "single", text: L("a"), options: opt("x", "y") },
      { id: "b", type: "text", showIf: { q: "a", in: ["gone"] }, text: L("b") },
    ]);
    assert.match(convertShowIf(old).error, /「b」在舊版裡沒有任何答案組合看得到它/);
  });
  test("沒有跳題的問卷：寫出照順序的出口；needsMigration 只認舊格式", () => {
    const old = base([{ id: "a", type: "rating", text: L("a") }, { id: "b_x", type: "multi", text: L("b"), options: opt("p", "other") },
      { id: "b_x_other", type: "text", inline: true, showIf: { q: "b_x", in: ["other"] }, text: L("o") }, { id: "c", type: "text", text: L("c") }]);
    assert.equal(needsMigration(old), true);
    const r = convertShowIf(old);
    assert.deepEqual(r.def.questions.map((q) => q.next), [{ else: "b_x" }, { else: "c" }, undefined, { else: "end" }]);
    assert.equal(checkEquivalent(old, r.def).ok, true);
    assert.equal(needsMigration(r.def), false);
    assert.equal(needsMigration(convertShowIf(legacyDef()).def), false);
  });
  test("等價檢查抓得到不一樣的路徑", () => {
    const old = legacyDef();
    const wrong = convertShowIf(old).def;
    wrong.questions.find((q) => q.id === "q_a").next = { rules: [{ in: ["yes"], to: "q_b" }], else: "q_email" }; // maybe 少了
    const eq = checkEquivalent(old, wrong);
    assert.equal(eq.ok, false);
    assert.equal(eq.mismatch.answers.q_a, "maybe");
    assert.ok(eq.mismatch.legacy.includes("q_b") && !eq.mismatch.flow.includes("q_b"));
  });
  test("組合太多就固定種子抽樣：每個條件題的每個值都至少出現一次，重跑結果一樣", () => {
    const many = opt(...Array.from({ length: 18 }, (_, i) => `o${i}`));
    const old = base([
      { id: "m", type: "multi", text: L("m"), options: many },
      { id: "m_other", type: "text", inline: true, showIf: { q: "m", in: ["o17"] }, text: L("x") },
      { id: "s", type: "single", text: L("s"), options: opt("a", "b") },
      { id: "t", type: "text", showIf: { q: "s", in: ["a"] }, text: L("t") },
    ]);
    const a = answerCombos(old, { sample: 300 }), b = answerCombos(old, { sample: 300 });
    assert.equal(a.sampled, true);
    assert.equal(a.combos.length, 300);
    assert.deepEqual(a.combos, b.combos);
    assert.ok(a.combos.some((x) => x.s === "a") && a.combos.some((x) => x.s === "b"));
    const r = convertShowIf(old, { sample: 300 });
    const eq = checkEquivalent(old, r.def, { sample: 300 });
    assert.equal(eq.ok, true);
    assert.equal(eq.sampled, true);
  });
});
