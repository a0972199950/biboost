// 問卷跳題的一次性轉換：舊的 showIf（「前面某題選了某些選項，這題才出現」）→ 流程圖的出口 next（src/survey-core.js 開頭的說明）。
// scripts/surveys.mjs 的 migrate-flow 子指令用；轉換後一定要過 checkEquivalent（新舊路徑一樣）才寫回資料庫。
//
// 轉換的做法：
//   1. 列舉「被當成跳題條件的題目」的所有答案組合（單選：沒回答＋每個選項；複選：所有子集合；預設選項加上各國變體的選項），
//      組合太多就固定亂數種子抽樣。每個組合用舊規則算出看得到的卡片順序，記下「卡片 X、X 的答案是 a → 下一張是 Y」
//   2. 每張卡片：沒回答時的下一張當「其他情況」（else）；往後找 showIf 指到這張卡片的題目，依陣列順序寫成 rules（第一條符合的勝出）
//   3. 用步驟 1 的紀錄逐條核對；同一張卡片、同一個答案在不同組合下要去不同地方（舊的條件引用了更前面的題目，新結構表達不了），就轉換失敗
//   4. 拿掉非 inline 題目的 showIf（inline 的說明框照舊用 showIf 掛在上游那題下面），再用 survey-core 驗證
// checkEquivalent：對同一批組合（含說明框）比對「舊的看得到的題目順序」與「新的路徑」，一個不同就不等價。
import "../../src/survey-core.js";

const Core = globalThis.BBSurveyCore;
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const LIMIT = 200000; // 超過這麼多組合就抽樣
const SAMPLE = 50000;

// 舊規則：依陣列順序，showIf 成立才看得到；上游看不到時它的答案不算（跟舊的 cleanAnswers 一樣）
export function legacyVisibleIds(def, answers) {
  const kept = {}, out = [];
  for (const q of def.questions || []) {
    if (!Core.isVisible(q, kept)) continue;
    out.push(q.id);
    if (answers[q.id] !== undefined) kept[q.id] = answers[q.id];
  }
  return out;
}
const legacyCards = (def, answers) => {
  const inline = new Set((def.questions || []).filter((q) => q.inline).map((q) => q.id));
  return legacyVisibleIds(def, answers).filter((id) => !inline.has(id));
};

function optionIds(q) {
  const ids = [];
  [q.options || []].concat((q.variants || []).map((v) => (isObj(v) && v.options) || [])).forEach((list) => {
    list.forEach((o) => { if (isObj(o) && !ids.includes(o.id)) ids.push(o.id); });
  });
  return ids;
}
function subsets(ids) {
  const out = [];
  for (let m = 0; m < 1 << ids.length; m++) out.push(ids.filter((_, i) => m & (1 << i)));
  return out;
}
// 被當成條件的題目（任何 showIf 指到的，含說明框的上游）與它們可能的答案
function drivers(def) {
  const byId = Object.fromEntries((def.questions || []).map((q) => [q.id, q]));
  const ids = [...new Set((def.questions || []).filter((q) => q.showIf && q.showIf.q).map((q) => q.showIf.q))].filter((id) => byId[id]);
  return ids.map((id) => {
    const q = byId[id], opts = optionIds(q);
    if (q.type === "multi") {
      if (opts.length > 16) return { id, values: null, opts, multi: true }; // 子集合太多：抽樣
      return { id, values: subsets(opts), multi: true };
    }
    return { id, values: [undefined].concat(opts) };
  });
}
// 32 位元的固定種子亂數（mulberry32）：抽樣結果每次一樣，方便重跑比對
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 答案組合：全部列舉，或（太多時）抽樣。回傳 { combos: [answers…], total, sampled }
export function answerCombos(def, { limit = LIMIT, sample = SAMPLE, seed = 20261118 } = {}) {
  const ds = drivers(def);
  const total = ds.reduce((n, d) => n * (d.values ? d.values.length : 2 ** d.opts.length), 1);
  if (total <= limit && ds.every((d) => d.values)) {
    const combos = [];
    (function walk(i, acc) {
      if (i === ds.length) { combos.push({ ...acc }); return; }
      for (const v of ds[i].values) { if (v === undefined) delete acc[ds[i].id]; else acc[ds[i].id] = v; walk(i + 1, acc); }
      delete acc[ds[i].id];
    })(0, {});
    return { combos, total, sampled: false };
  }
  const r = rng(seed), combos = [];
  // 每個條件題的每個值至少出現一次（其他題沒回答），再補隨機組合
  for (const d of ds) for (const v of d.values || d.opts.map((o) => [o])) combos.push(v === undefined ? {} : { [d.id]: v });
  while (combos.length < sample) {
    const a = {};
    for (const d of ds) {
      const v = d.values ? d.values[Math.floor(r() * d.values.length)] : d.opts.filter(() => r() < 0.5);
      if (v !== undefined) a[d.id] = v;
    }
    combos.push(a);
  }
  return { combos, total, sampled: true };
}

const keyOf = (q, v) => (q.type === "multi" ? Core.asArray(v).slice().sort().join("|") : v === undefined ? "∅" : String(v));

// 轉換：回傳 { def }，或 { error: "中文說明" }（轉換不了、或轉換後的定義過不了 survey-core 的檢查）
export function convertShowIf(oldDef, opts) {
  const def = clone(oldDef);
  const qs = def.questions || [];
  const cards = qs.filter((q) => !q.inline);
  if (!cards.some((q) => q.showIf)) {
    // 沒有跳題：每張卡片照順序走，寫出明確的出口（流程圖編輯器的格式）
    cards.forEach((q, i) => { q.next = { else: i + 1 < cards.length ? cards[i + 1].id : Core.END }; delete q.showIf; });
    return finish(def);
  }
  const { combos } = answerCombos(oldDef, opts);
  // 觀察：卡片 X、X 的答案 → 下一張
  const obs = new Map(cards.map((q) => [q.id, new Map()]));
  for (const a of combos) {
    const seq = legacyCards(oldDef, a);
    for (let k = 0; k < seq.length; k++) {
      const q = cards.find((c) => c.id === seq[k]);
      const to = k + 1 < seq.length ? seq[k + 1] : Core.END;
      const m = obs.get(q.id), key = keyOf(q, a[q.id]);
      if (!m.has(key)) m.set(key, { to, a });
      else if (m.get(key).to !== to) {
        return { error: `「${q.id}」轉換不了：同樣的答案在不同情況下會走到「${m.get(key).to}」或「${to}」（舊的跳題條件引用了更前面的題目，新的流程圖只能看這一題自己的答案）` };
      }
    }
  }
  for (const [i, q] of cards.entries()) {
    const m = obs.get(q.id);
    if (!m.size) return { error: `「${q.id}」在舊版裡沒有任何答案組合看得到它，轉換後會是走不到的卡片，請先修正` };
    const empty = m.get(keyOf(q, undefined));
    // 沒回答時的下一張＝其他情況。不是條件題的卡片，答案不影響下一張（所有觀察都一樣）
    const elseTo = empty ? empty.to : [...m.values()][0].to;
    const rules = [];
    if (Core.BRANCH_TYPES.includes(q.type)) {
      const stop = elseTo === Core.END ? cards.length : cards.findIndex((c) => c.id === elseTo);
      const used = new Set();
      for (const c of cards.slice(i + 1, stop)) {
        if (!(c.showIf && c.showIf.q === q.id)) continue;
        const ins = (c.showIf.in || []).filter((id) => !(q.type === "single" && used.has(id)));
        if (!ins.length) continue;
        rules.push({ in: ins, to: c.id });
        ins.forEach((id) => used.add(id));
      }
    }
    q.next = rules.length ? { rules, else: elseTo } : { else: elseTo };
    // 逐條核對觀察
    for (const [key, { to, a }] of m) {
      const got = Core.nextOf(def, q, a);
      if (got !== to) return { error: `「${q.id}」轉換不了：答案 ${key} 舊版走到「${to}」，轉換後走到「${got}」` };
    }
  }
  cards.forEach((q) => { delete q.showIf; });
  return finish(def);
}
function finish(def) {
  // 翻譯沒齊之類的問題跟轉換無關；只看流程圖
  const errs = Core.checkFlow(def);
  if (errs.length) return { error: `轉換後的流程圖有問題：${errs.map((e) => `${e.path} ${e.message}`).join("；")}`, def };
  return { def };
}

// 等價檢查：每個組合（含說明框）的舊「看得到的題目」＝新「路徑上的題目」（順序也要一樣）。
// 回傳 { ok, total（全部組合數）, checked（實際比對的組合數）, sampled, mismatch: { answers, legacy, flow } | null }
export function checkEquivalent(oldDef, newDef, opts) {
  const { combos, total, sampled } = answerCombos(oldDef, opts);
  for (const a of combos) {
    const legacy = legacyVisibleIds(oldDef, a), flow = Core.pathIds(newDef, a);
    if (legacy.join(",") !== flow.join(",")) return { ok: false, total, checked: combos.length, sampled, mismatch: { answers: a, legacy, flow } };
  }
  return { ok: true, total, checked: combos.length, sampled, mismatch: null };
}

// 只有舊格式（非 inline 題目有 showIf，或卡片沒有寫出口）才需要轉換
export function needsMigration(def) {
  return (def.questions || []).some((q) => !q.inline && (q.showIf || q.next == null));
}
