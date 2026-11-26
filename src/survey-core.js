/*
 * 問卷核心：純函式、沒有依賴。擴充（survey-ui.js、survey.js）、後台 Worker（tools/report-worker/src/surveys.js）、
 * 後台共用這一份，三邊的分頁、跳題、作答驗證規則才會一致。只有規則，沒有題目內容（題目存在資料庫、由伺服器下發）。
 *
 * 問卷定義（後台存的原始定義；伺服器下發前用 resolve() 依國家套用變體）：
 *   { id, name, title: {語言: 文字}, prompt: { invite: {…}, <事件>: {…} }, triggers: { invite: true, events: [...] },
 *     audience: { countries: [], langs: [] }, weight, questions: [題目…] }
 *   題目：{ id, type, required, next, inline, showIf, text, options: [{ id, text }], shuffle, maxSelect,
 *           maxLength, scale: { style, labels: { low, high } }, labels: { low, high }, range: { min, max, step, unit }, variants: [...] }
 *   期間、份數上限、發布狀態存在資料表的欄位，不在定義裡。
 *
 * 選項可以帶後台自己用的其他欄位；resolve() 下發時選項只留 id 與 text。
 *
 * 跳題是流程圖：每一題（inline 以外）是一張卡片，卡片有一串出口
 *   next: { rules: [{ in: [選項 id…], to: "<題目 id>" | "end" }], else: "<題目 id>" | "end" }
 *   · 由上往下比對，第一條符合的勝出；都不符合（或沒回答）走 else（「其他情況」）。條件只看這一題自己的答案
 *   · rules 只有單選、複選可以用（「選了／勾了其中任一個」）；其他題型只有 else（下一題）
 *   · to／else 只能指到陣列裡後面的卡片或 "end"（結束）：陣列順序就是流程的順序，所以不會繞回前面、不會有環
 *   · 沒有 next、或 next 沒有 else：走陣列裡下一張卡片，最後一張之後結束（後台的流程圖編輯器一律寫出完整的 next）
 *   · inline（選了「其他」才出現的說明框）不是卡片：畫在 showIf 指到的那一題下面，沒有出口；showIf 只給 inline 用
 *   · def.layout：後台流程圖的卡片位置，擴充不用（resolve() 不下發）
 *   · def.revisions：發布後的修改紀錄，只給後台看（resolve() 不下發；lockedChanges() 不比）
 * 語言代碼用擴充 _locales 的寫法（zh_TW、zh_HK…）。
 */
var BBSurveyCore = (function () {
  "use strict";

  var LANGS = ["zh_TW", "zh_HK", "zh_CN", "en", "ja", "ko"];
  var TYPES = ["single", "multi", "text", "longtext", "email", "rating", "nps", "number", "rank"];
  var CHOICE_TYPES = ["single", "multi", "rank"]; // 有選項的題型
  var FIELD_TYPES = ["text", "longtext", "email"]; // 輸入框；排在最後的連續幾題併成一頁
  var AUTO_NEXT_TYPES = ["single", "rating", "nps"]; // 第一次作答點了就進下一題
  // 事件觸發的目錄：偵測程式寫在擴充裡（survey-page.js），問卷在後台只能勾選這裡有的
  var EVENTS = ["region_blocked"];
  var ENTRIES = ["invite", "announcement", "console"].concat(EVENTS);
  var BROWSERS = ["chrome", "edge", "firefox", "safari"];
  var INSTALL_DAYS = ["lt7", "7_30", "30_90", "gt90"];
  var LIMITS = { text: 500, longtext: 2000, inline: 200, email: 254, options: 30, questions: 40, label: 300 };
  // 擴充從哪一版開始畫得出這些功能：問卷用到的功能裡最新的那一版就是它的 minExtVersion。
  // 這個模組上架前，基準先用目前的版本（開發版要拿得到問卷）；之後新增題型或設定時，在 FEATURE_SINCE 登記新的版本
  var BASE_EXT_VERSION = "2.10.1";
  var FEATURE_SINCE = {};
  var CN = "CN"; // 中國大陸一律不顯示問卷

  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function asArray(v) { return Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]); }
  function hasAnswer(v) { return Array.isArray(v) ? v.length > 0 : (v != null && String(v).trim() !== ""); }
  function inList(list, v) { return list.indexOf(v) >= 0; }

  // { 語言: 文字 } 依語言挑；粵語沒有就用繁中，再退英文、繁中、任一
  function pick(map, lang) {
    if (!isObj(map)) return "";
    if (map[lang]) return map[lang];
    if (lang === "zh_HK" && map.zh_TW) return map.zh_TW;
    return map.en || map.zh_TW || map[Object.keys(map)[0]] || "";
  }

  // 說明框（inline）出不出現：上游是單選（字串）或複選（陣列）都可以，有任一個答案在 showIf.in 裡就出現。
  // 卡片（非 inline）不看 showIf，走不走得到由流程圖的出口決定（pathOf）
  function isVisible(q, answers) {
    if (!q.showIf) return true;
    var got = asArray(answers && answers[q.showIf.q]);
    var want = q.showIf.in || [];
    for (var i = 0; i < got.length; i++) if (inList(want, got[i])) return true;
    return false;
  }

  // ---- 流程圖 ----
  var END = "end";
  var BRANCH_TYPES = ["single", "multi"]; // 可以依答案分岔（出口有 rules）的題型
  // 卡片＝inline 以外的題目，照陣列順序
  function cardsOf(def) { return (def.questions || []).filter(function (q) { return isObj(q) && !q.inline; }); }
  // 這張卡片的出口，展開成明確的目的地：{ rules: [{ in, to }], else }。沒寫 else 的走陣列裡下一張卡片（最後一張之後＝結束）
  function exitsOf(def, q) {
    var cards = cardsOf(def), i = -1;
    for (var k = 0; k < cards.length; k++) if (cards[k].id === q.id) { i = k; break; }
    var dflt = i >= 0 && i + 1 < cards.length ? cards[i + 1].id : END;
    var n = isObj(q.next) ? q.next : {};
    var rules = inList(BRANCH_TYPES, q.type) && Array.isArray(n.rules) ? n.rules.filter(isObj).map(function (r) {
      return { in: Array.isArray(r.in) ? r.in.slice() : [], to: r.to };
    }) : [];
    return { rules: rules, else: typeof n.else === "string" && n.else ? n.else : dflt };
  }
  // 依這一題自己的答案決定下一張：由上往下第一條符合的出口；都不符合（或沒回答）走「其他情況」
  function nextOf(def, q, answers) {
    var ex = exitsOf(def, q), got = asArray(answers && answers[q.id]);
    for (var i = 0; i < ex.rules.length; i++) {
      for (var j = 0; j < got.length; j++) if (inList(ex.rules[i].in, got[j])) return ex.rules[i].to;
    }
    return ex.else;
  }
  // 依目前答案實際走到的卡片（照順序）：從第一張沿著出口走到結束。
  // 出口壞掉（指到不存在的題目、說明框、或前面的卡片）一律當成結束：存檔和發布會擋，這裡只保證一定走得完（不會無限迴圈）
  function pathOf(def, answers) {
    var out = [];
    walkCards(def, answers, function (q) { out.push(q); });
    return out;
  }
  // 沿著路徑走，每到一張卡片先呼叫 visit(q)，再用 answers 決定下一張（cleanAnswers 在 visit 裡把驗證過的答案寫進 answers）
  function walkCards(def, answers, visit) {
    var cards = cardsOf(def), at = {};
    cards.forEach(function (q, i) { if (!Object.prototype.hasOwnProperty.call(at, q.id)) at[q.id] = i; });
    var i = cards.length ? 0 : -1;
    while (i >= 0) {
      var q = cards[i];
      visit(q);
      var to = nextOf(def, q, answers);
      var j = to !== END && Object.prototype.hasOwnProperty.call(at, to) ? at[to] : -1;
      i = j > i ? j : -1;
    }
  }
  // 路徑上的題目 id：走到的卡片，加上掛在它們下面、目前打開的說明框。送出、驗證、結果頁的分母都看這個
  function pathIds(def, answers) {
    var ids = [];
    pathOf(def, answers).forEach(function (q) {
      ids.push(q.id);
      inlineOf(def, q.id).forEach(function (x) { if (isVisible(x, answers)) ids.push(x.id); });
    });
    return ids;
  }

  // 目前路徑上的頁面：[[題目…], …]。一題一頁；inline 的題目畫在它 showIf 指到的那一題下面，不自成一頁；
  // 路徑尾端連續的輸入框題（短文字、長文字、Email）併成同一頁。總頁數會隨答案變（走不同的路）
  function pagesOf(def, answers) {
    var qs = pathOf(def, answers);
    var cut = qs.length;
    while (cut > 0 && inList(FIELD_TYPES, qs[cut - 1].type)) cut--;
    var pages = qs.slice(0, cut).map(function (q) { return [q]; });
    if (cut < qs.length) pages.push(qs.slice(cut));
    return pages;
  }
  // 掛在某一題下面的 inline 題目（例如選了「其他」才出現的說明框）
  function inlineOf(def, qid) {
    return (def.questions || []).filter(function (x) { return x.inline && x.showIf && x.showIf.q === qid; });
  }
  // 會打開 inline 題目的選項（「其他」）：隨機排序時固定在最後
  function opensInline(def, q, optId) {
    return inlineOf(def, q.id).some(function (x) { return inList(x.showIf.in || [], optId); });
  }
  // 選項的顯示順序（選項 id 陣列）。shuffle 時用 rand（0～1 的亂數函式）打亂一次；會打開說明框的選項固定在最後
  function optionOrder(def, q, rand) {
    var ids = (q.options || []).map(function (o) { return o.id; });
    if (!q.shuffle) return ids;
    var tail = ids.filter(function (id) { return opensInline(def, q, id); });
    var body = ids.filter(function (id) { return !inList(tail, id); });
    var r = rand || Math.random;
    for (var i = body.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = body[i]; body[i] = body[j]; body[j] = t; }
    return body.concat(tail);
  }

  // ---- 選項 ----
  // 這題的選項清單：預設選項＋每個「換選項」的國家變體
  function optionLists(q) {
    var lists = [Array.isArray(q.options) ? q.options : []];
    (q.variants || []).forEach(function (v) { if (isObj(v) && Array.isArray(v.options)) lists.push(v.options); });
    return lists;
  }

  // ---- 版本與對象 ----
  function cmpVersion(a, b) {
    var x = String(a || "0").split(".").map(Number), y = String(b || "0").split(".").map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  function minExtVersion(def) {
    var v = BASE_EXT_VERSION;
    (def.questions || []).forEach(function (q) {
      var since = FEATURE_SINCE["type:" + q.type];
      if (since && cmpVersion(since, v) > 0) v = since;
    });
    return v;
  }
  // 這份問卷要不要給這個國家、這個介面語言的人（中國大陸一律不要）
  function audienceMatch(def, country, lang) {
    if (country === CN) return false;
    var a = def.audience || {};
    if (a.countries && a.countries.length && !inList(a.countries, country)) return false;
    if (a.langs && a.langs.length && !inList(a.langs, lang)) return false;
    return true;
  }

  // 依國家套用變體，回傳下發給擴充的格式（拿掉 variants、audience、name 這些擴充用不到的）
  function resolve(def, country) {
    return {
      id: def.id,
      title: def.title || {},
      prompt: def.prompt || {},
      triggers: { invite: !!(def.triggers && def.triggers.invite), events: ((def.triggers && def.triggers.events) || []).slice() },
      weight: typeof def.weight === "number" ? def.weight : 1,
      minExtVersion: minExtVersion(def),
      questions: (def.questions || []).map(function (q) {
        var out = {}, k;
        for (k in q) if (k !== "variants") out[k] = q[k];
        var v = (q.variants || []).filter(function (x) { return x && inList(x.countries || [], country); })[0];
        if (v) {
          if (v.text) out.text = v.text;
          if (v.options) out.options = v.options;
        }
        // 選項只下發 id 與 text（其他欄位是後台自己用的）
        if (Array.isArray(out.options)) out.options = out.options.map(function (o) {
          return isObj(o) ? { id: o.id, text: o.text } : o;
        });
        return out;
      })
    };
  }

  // ---- 定義驗證（後台存檔、發布前用）----
  // opts.publish：發布前的完整檢查（目標語言的文字都要齊）。回傳錯誤陣列 [{ path, message }]，空陣列＝沒問題
  var ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
  var QID_RE = /^[a-z][a-z0-9_]{0,39}$/;
  var OID_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;
  function validateDefinition(def, opts) {
    var errs = [];
    function err(path, message) { errs.push({ path: path, message: message }); }
    if (!isObj(def)) { err("", "格式錯誤"); return errs; }
    var publish = !!(opts && opts.publish);
    var langs = def.audience && def.audience.langs && def.audience.langs.length ? def.audience.langs : LANGS;
    function text(path, map, required) {
      if (map == null) { if (required) err(path, "要填文字"); return; }
      if (!isObj(map)) { err(path, "格式錯誤"); return; }
      Object.keys(map).forEach(function (l) {
        if (!inList(LANGS, l)) err(path + "." + l, "不認得的語言 " + l);
        else if (typeof map[l] !== "string") err(path + "." + l, "要是文字");
        else if (map[l].length > LIMITS.label * 3) err(path + "." + l, "太長");
      });
      if (required && publish) langs.forEach(function (l) { if (!map[l] || !String(map[l]).trim()) err(path + "." + l, "缺 " + l + " 的文字"); });
      if (required && !publish && !Object.keys(map).some(function (l) { return map[l] && String(map[l]).trim(); })) err(path, "至少要填一種語言");
    }

    if (typeof def.id !== "string" || !ID_RE.test(def.id)) err("id", "id 要是 2～48 個小寫英數字或連字號，開頭不能是連字號");
    text("title", def.title, true);
    var t = def.triggers || {};
    var events = Array.isArray(t.events) ? t.events : [];
    events.forEach(function (e, i) { if (!inList(EVENTS, e)) err("triggers.events." + i, "擴充不認得的事件 " + e); });
    if (!t.invite && !events.length) err("triggers", "至少要選一種觸發方式");
    var prompt = def.prompt || {};
    text("prompt.invite", prompt.invite, true);
    events.forEach(function (e) { if (prompt[e] != null) text("prompt." + e, prompt[e], false); });
    var a = def.audience || {};
    (a.countries || []).forEach(function (c, i) { if (!/^[A-Z]{2}$/.test(c)) err("audience.countries." + i, "國家要是兩碼大寫代碼，例如 TW"); });
    (a.langs || []).forEach(function (l, i) { if (!inList(LANGS, l)) err("audience.langs." + i, "不認得的語言 " + l); });
    if (def.weight != null && !(typeof def.weight === "number" && def.weight > 0 && def.weight <= 100)) err("weight", "權重要是 0～100 的數字");

    var qs = Array.isArray(def.questions) ? def.questions : [];
    if (!qs.length) err("questions", "至少要一題");
    if (qs.length > LIMITS.questions) err("questions", "題目太多（最多 " + LIMITS.questions + " 題）");
    var seen = {}, emails = 0;
    qs.forEach(function (q, i) {
      var p = "questions." + i;
      if (!isObj(q)) { err(p, "格式錯誤"); return; }
      if (typeof q.id !== "string" || !QID_RE.test(q.id)) err(p + ".id", "題目 id 要是小寫英文開頭的英數字與底線");
      else if (seen[q.id]) err(p + ".id", "題目 id 重複：" + q.id);
      if (!inList(TYPES, q.type)) { err(p + ".type", "不認得的題型 " + q.type); seen[q.id] = q; return; }
      text(p + ".text", q.text, true);
      if (q.type === "email" && ++emails > 1) err(p, "一份問卷只能有一題 Email");
      function checkOptions(list, path) {
        if (!Array.isArray(list) || list.length < 2) { err(path, "至少要兩個選項"); return; }
        if (list.length > LIMITS.options) err(path, "選項太多");
        var ids = {};
        list.forEach(function (o, j) {
          if (!isObj(o) || typeof o.id !== "string" || !OID_RE.test(o.id)) err(path + "." + j + ".id", "選項 id 要是小寫英數字與底線");
          else if (ids[o.id]) err(path + "." + j + ".id", "選項 id 重複：" + o.id);
          else ids[o.id] = true;
          if (isObj(o)) text(path + "." + j + ".text", o.text, true);
        });
      }
      if (inList(CHOICE_TYPES, q.type)) checkOptions(q.options, p + ".options");
      else if (q.options != null) err(p + ".options", "這種題型沒有選項");
      if (q.type === "multi" && q.maxSelect != null && !(Number.isInteger(q.maxSelect) && q.maxSelect >= 1 && q.maxSelect <= (q.options || []).length)) err(p + ".maxSelect", "最多選幾個要是 1 到選項數之間的整數");
      if ((q.type === "text" || q.type === "longtext") && q.maxLength != null && !(Number.isInteger(q.maxLength) && q.maxLength >= 1 && q.maxLength <= LIMITS.longtext)) err(p + ".maxLength", "字數上限要是 1～" + LIMITS.longtext);
      if (q.type === "rating") {
        var sc = q.scale || {};
        if (sc.style != null && sc.style !== "star" && sc.style !== "number") err(p + ".scale.style", "評分樣式只能是 star 或 number");
        if (sc.labels) { text(p + ".scale.labels.low", sc.labels.low, false); text(p + ".scale.labels.high", sc.labels.high, false); }
      }
      if (q.type === "nps" && q.labels) { text(p + ".labels.low", q.labels.low, false); text(p + ".labels.high", q.labels.high, false); }
      if (q.type === "number") {
        var r = q.range || {};
        if (typeof r.min !== "number" || typeof r.max !== "number" || !(r.min < r.max)) err(p + ".range", "數字題要有最小值與最大值（最小值小於最大值）");
        if (r.step != null && !(typeof r.step === "number" && r.step > 0)) err(p + ".range.step", "間隔要大於 0");
        if (r.unit) text(p + ".range.unit", r.unit, false);
      }
      if (q.shuffle && !inList(CHOICE_TYPES, q.type)) err(p + ".shuffle", "只有單選、複選、排序可以隨機排序選項");
      if (q.inline) {
        if (q.next != null) err(p + ".next", "說明框「" + q.id + "」沒有出口（它畫在上游那題的卡片裡）");
        if (q.type !== "text") err(p + ".inline", "附在選項下面的說明框只能是短文字題");
        if (!q.showIf) err(p + ".inline", "說明框要指定在哪一題的哪個選項出現");
        if (q.required) err(p + ".required", "說明框只能是選填");
      }
      if (q.showIf != null && !q.inline) err(p + ".showIf", "「" + q.id + "」：跳題改用流程圖的出口（next）；showIf 只給選項下面的說明框用");
      else if (q.showIf != null) {
        var up = isObj(q.showIf) && seen[q.showIf.q];
        if (!up) err(p + ".showIf", "說明框「" + q.id + "」要指到前面的題目");
        else if (up.type !== "single" && up.type !== "multi") err(p + ".showIf", "說明框「" + q.id + "」只能掛在單選或複選題下面");
        else if (up.inline) err(p + ".showIf", "說明框「" + q.id + "」不能掛在另一個說明框下面");
        else {
          // 預設選項與各國變體的選項都算（例如港澳台沒有的選項，在其他國家的版本裡有）
          var upIds = {};
          [up.options || []].concat((up.variants || []).map(function (v) { return (v && v.options) || []; })).forEach(function (list) {
            list.forEach(function (o) { if (o) upIds[o.id] = true; });
          });
          var want = Array.isArray(q.showIf.in) ? q.showIf.in : [];
          if (!want.length) err(p + ".showIf.in", "跳題條件至少要選一個選項");
          want.forEach(function (id) { if (!upIds[id]) err(p + ".showIf.in", "「" + q.showIf.q + "」沒有選項 " + id); });
        }
      }
      // 同一個國家只能在一組變體裡（resolve() 只套第一組符合的，後面那組會默默失效）
      var variantOf = {};
      (q.variants || []).forEach(function (v, j) {
        var vp = p + ".variants." + j;
        if (!isObj(v) || !Array.isArray(v.countries) || !v.countries.length) { err(vp, "變體要指定國家"); return; }
        v.countries.forEach(function (c) { if (!/^[A-Z]{2}$/.test(c)) err(vp + ".countries", "國家要是兩碼大寫代碼"); });
        v.countries.filter(function (c, k) { return v.countries.indexOf(c) === k; }).forEach(function (c) {
          if (Object.prototype.hasOwnProperty.call(variantOf, c)) err(p + ".variants", "國家 " + c + " 同時在第 " + (variantOf[c] + 1) + " 個和第 " + (j + 1) + " 個國家變體裡，只能放一組");
          else variantOf[c] = j;
        });
        if (v.text) text(vp + ".text", v.text, true);
        if (v.options) { if (!inList(CHOICE_TYPES, q.type)) err(vp + ".options", "這種題型沒有選項"); else checkOptions(v.options, vp + ".options"); }
      });
      seen[q.id] = q;
    });
    flowErrors(def, qs, err);
    if (def.layout != null && !isObj(def.layout)) err("layout", "格式錯誤");
    // 題目層級的錯誤標上題目 id（後台的流程圖用它把錯誤標在那張卡片上）
    errs.forEach(function (e) {
      var m = /^questions\.(\d+)/.exec(e.path);
      if (m && !e.q && isObj(qs[+m[1]]) && typeof qs[+m[1]].id === "string") e.q = qs[+m[1]].id;
    });
    return errs;
  }

  // 只檢查流程圖（report worker 下發清單、收作答前用；遷移工具用）：卡片不能用 showIf、出口要對。回傳 [{ path, message, q }]
  function checkFlow(def) {
    var errs = [];
    var qs = isObj(def) && Array.isArray(def.questions) ? def.questions : [];
    function err(path, message) {
      var m = /^questions\.(\d+)/.exec(path), q = m && qs[+m[1]];
      errs.push({ path: path, message: message, q: isObj(q) ? q.id : undefined });
    }
    qs.forEach(function (q, i) {
      if (isObj(q) && !q.inline && q.showIf != null) err("questions." + i + ".showIf", "「" + q.id + "」：跳題改用流程圖的出口（next）；showIf 只給選項下面的說明框用");
      if (isObj(q) && q.inline && q.next != null) err("questions." + i + ".next", "說明框「" + q.id + "」沒有出口（它畫在上游那題的卡片裡）");
    });
    flowErrors(def, qs, err);
    return errs;
  }

  // ---- 發布後的修改（後台存檔用）----
  // 已發布的問卷只能改文字與基本設定；回傳不准改的差異 [{ path, message, q }]，空陣列＝可以存。
  // 寫法是「只列出可以改的欄位」，其他欄位（包含之後新增、還沒分類的）只要有變就算結構變動、一律擋：
  // 忘了分類的新欄位結果只會是改不了，不會變成漏洞。可以改的：
  //   · 文字（{ 語言: 文字 }）：title、prompt.invite／prompt.<事件>、題目 text、選項 text、scale.labels.low/high、labels.low/high、
  //     range.unit、變體的 text 與變體選項的 text（可以新增、刪除語言，也可以從沒有變成有）
  //   · 基本設定：triggers.invite、triggers.events、audience.countries、audience.langs、weight、name
  //     （opts.textOnly：已結束的問卷，基本設定也不能改，只剩文字與 name）
  //   · next：意思一樣就好（exitsOf 展開後相同；沒寫 else＝下一張，跟寫明的一樣）
  //   · revisions：修改紀錄，伺服器自己維護，不比
  // 期間、份數上限存在資料表的欄位，不在定義裡，由呼叫端檢查
  var LOCKED = "發布後不能改";
  function lockedChanges(oldDef, newDef, opts) {
    var out = [];
    if (!isObj(oldDef) || !isObj(newDef)) return [{ path: "", message: "格式錯誤" }];
    var textOnly = !!(opts && opts.textOnly);
    var qs = Array.isArray(newDef.questions) ? newDef.questions : [];
    function lock(path, message) {
      var m = /^questions\.(\d+)/.exec(path), q = m && qs[+m[1]];
      out.push({ path: path, message: message || LOCKED, q: isObj(q) && typeof q.id === "string" ? q.id : undefined });
    }
    function same(a, b) {
      if (a === b) return true;
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
        return true;
      }
      if (!isObj(a) || !isObj(b)) return false;
      // 值是 undefined 的欄位當成沒有（JSON 存檔後就不見了）
      var keys = keysOf(a, b);
      for (var k = 0; k < keys.length; k++) if (!same(a[keys[k]], b[keys[k]])) return false;
      return true;
    }
    function keysOf(a, b) {
      var seen = {}, keys = [];
      [a, b].forEach(function (o) {
        Object.keys(o).forEach(function (k) { if (o[k] !== undefined && !seen[k]) { seen[k] = true; keys.push(k); } });
      });
      return keys;
    }
    function isText(v) {
      if (v == null) return true;
      if (!isObj(v)) return false;
      return Object.keys(v).every(function (l) { return v[l] == null || typeof v[l] === "string"; });
    }
    // 依欄位表比對一個物件：表裡有的交給它的比對函式，沒有的要一模一樣
    function fields(a, b, path, table) {
      if (same(a, b)) return;
      if (!(a == null || isObj(a)) || !(b == null || isObj(b))) { lock(path); return; }
      var x = a || {}, y = b || {};
      keysOf(x, y).forEach(function (k) {
        var p = path ? path + "." + k : k;
        if (Object.prototype.hasOwnProperty.call(table, k)) table[k](x[k], y[k], p);
        else if (!same(x[k], y[k])) lock(p);
      });
    }
    function text(a, b, path) { if (!same(a, b) && !(isText(a) && isText(b))) lock(path); }
    function setting(a, b, path) { if (!same(a, b)) { if (textOnly) lock(path, "已結束的問卷只能改文字"); } }
    function ignore() {}
    function options(a, b, path, message) {
      if (same(a, b)) return;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length ||
          a.some(function (o, j) { return !isObj(o) || !isObj(b[j]) || o.id !== b[j].id; })) {
        lock(path, message || "發布後不能新增、刪除選項，或改選項的 id、順序");
        return;
      }
      a.forEach(function (o, j) { fields(o, b[j], path + "." + j, { text: text }); });
    }
    var LOW_HIGH = { low: text, high: text };
    function question(i) {
      return function (a, b, path) {
        fields(a, b, path, {
          text: text,
          options: options,
          scale: function (x, y, p) { fields(x, y, p, { labels: function (s, t, pp) { fields(s, t, pp, LOW_HIGH); } }); },
          labels: function (x, y, p) { fields(x, y, p, LOW_HIGH); },
          range: function (x, y, p) { fields(x, y, p, { unit: text }); },
          variants: function (x, y, p) {
            if (same(x, y)) return;
            if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) { lock(p, "發布後不能新增或刪除國家變體"); return; }
            x.forEach(function (v, k) {
              fields(v, y[k], p + "." + k, {
                text: text,
                options: function (s, t, pp) {
                  if (s == null || t == null) { if (!same(s, t)) lock(pp, "發布後不能開關變體的「換選項」"); return; }
                  options(s, t, pp);
                }
              });
            });
          },
          next: function (x, y, p) {
            var qa = oldDef.questions[i], qb = newDef.questions[i];
            if (same(x, y)) return;
            if (qa.inline || qb.inline || !same(exitsOf(oldDef, qa), exitsOf(newDef, qb))) lock(p);
          }
        });
      };
    }
    fields(oldDef, newDef, "", {
      name: function (a, b, p) { if (!same(a, b) && !((a == null || typeof a === "string") && (b == null || typeof b === "string"))) lock(p); },
      title: text,
      prompt: function (a, b, p) {
        var table = { invite: text };
        EVENTS.forEach(function (e) { table[e] = text; });
        fields(a, b, p, table);
      },
      triggers: function (a, b, p) { fields(a, b, p, { invite: setting, events: setting }); },
      audience: function (a, b, p) { fields(a, b, p, { countries: setting, langs: setting }); },
      weight: setting,
      revisions: ignore,
      questions: function (a, b, p) {
        if (same(a, b)) return;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length ||
            a.some(function (q, i) { return !isObj(q) || !isObj(b[i]) || q.id !== b[i].id; })) {
          lock(p, "發布後不能新增、刪除題目，或改題目的 id、順序");
          return;
        }
        a.forEach(function (q, i) { question(i)(q, b[i], p + "." + i); });
      }
    });
    return out;
  }

  // 流程圖的檢查：出口的格式、只有單選複選能分岔、選項要存在（預設或任一國家變體）、目的地要存在而且在後面（不能繞回前面＝沒有環）、
  // 不會生效的出口、每張卡片都要走得到
  function flowErrors(def, qs, err) {
    var cards = [], at = {}, byId = {};
    qs.forEach(function (q, i) {
      if (!isObj(q) || typeof q.id !== "string") return;
      if (!(q.id in byId)) byId[q.id] = { q: q, i: i };
      if (!q.inline && !(q.id in at)) { at[q.id] = cards.length; cards.push(q); }
    });
    var edges = cards.map(function () { return []; });
    cards.forEach(function (q, ci) {
      var p = "questions." + byId[q.id].i, name = "「" + q.id + "」";
      var n = q.next;
      function target(path, to) {
        if (to === END) return true;
        if (typeof to !== "string" || !to) { err(path, name + "的出口沒有設定目的地"); return false; }
        if (!(to in byId)) { err(path, name + "的出口指到不存在的題目「" + to + "」"); return false; }
        if (!(to in at)) { err(path, name + "的出口指到說明框「" + to + "」（說明框不能當目的地）"); return false; }
        if (at[to] <= ci) { err(path, name + "的出口指回" + (to === q.id ? "自己" : "前面的題目「" + to + "」") + "（不能繞回去）"); return false; }
        edges[ci].push(at[to]);
        return true;
      }
      if (n == null) { if (ci + 1 < cards.length) edges[ci].push(ci + 1); return; }
      if (!isObj(n)) { err(p + ".next", name + "的出口格式錯誤"); return; }
      if (n.else != null) target(p + ".next.else", n.else);
      else if (ci + 1 < cards.length) edges[ci].push(ci + 1);
      if (n.rules == null) return;
      if (!Array.isArray(n.rules)) { err(p + ".next.rules", name + "的出口格式錯誤"); return; }
      if (n.rules.length && !inList(BRANCH_TYPES, q.type)) {
        err(p + ".next.rules", name + "是" + ({ rank: "排序", text: "短文字", longtext: "長文字", email: "Email", rating: "評分", nps: "推薦分數", number: "數字" }[q.type] || q.type) +
          "題，只能有一條「下一題」；依答案分岔只有單選、複選可以");
        return;
      }
      var optIds = {};
      [q.options || []].concat((q.variants || []).map(function (v) { return (isObj(v) && v.options) || []; })).forEach(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (o) { if (isObj(o)) optIds[o.id] = true; });
      });
      var used = {};
      n.rules.forEach(function (r, k) {
        var rp = p + ".next.rules." + k, nth = name + "的第 " + (k + 1) + " 條出口";
        if (!isObj(r)) { err(rp, nth + "格式錯誤"); return; }
        var ins = Array.isArray(r.in) ? r.in : [];
        if (!ins.length) err(rp + ".in", nth + "要選至少一個選項");
        ins.forEach(function (id) { if (!optIds[id]) err(rp + ".in", nth + "用到不存在的選項「" + id + "」"); });
        // 第一條符合的勝出：單選的選項只能出現在一條；複選的一條出口如果選項全被上面接走，永遠用不到
        if (q.type === "single") {
          ins.forEach(function (id) { if (used[id]) err(rp + ".in", nth + "的選項「" + id + "」在上面的出口已經用過，這裡不會生效"); });
        } else if (ins.length && ins.every(function (id) { return used[id]; })) {
          err(rp + ".in", nth + "永遠用不到：它的選項都已經被上面的出口接走了");
        }
        ins.forEach(function (id) { used[id] = true; });
        target(rp + ".to", r.to);
      });
    });
    // 走不走得到：從第一張卡片沿著所有出口
    var reach = cards.map(function () { return false; }), stack = cards.length ? [0] : [];
    while (stack.length) {
      var c = stack.pop();
      if (reach[c]) continue;
      reach[c] = true;
      edges[c].forEach(function (t) { if (!reach[t]) stack.push(t); });
    }
    cards.forEach(function (q, ci) {
      if (!reach[ci]) err("questions." + byId[q.id].i, "「" + q.id + "」走不到：沒有任何出口連到這題");
    });
  }

  // ---- 驗證錯誤轉成給人看的一句話（後台、CLI 顯示用；path、message 不變）----
  // 題目用流程圖上的題號（第幾張卡片，不是陣列索引）＋題目 id；說明框寫成「第 N 題的說明框（id）」；其他欄位用中文名稱。
  //   questions.9.text「至少要填一種語言」→「第 9 題（q1）：題目文字至少要填一種語言」
  //   questions.9.options.0.text →「第 9 題（q1）的第 1 個選項：文字至少要填一種語言」
  var LANG_NAME = { zh_TW: "繁中", zh_HK: "粵語", zh_CN: "簡中", en: "英文", ja: "日文", ko: "韓文" };
  var EVENT_NAME = { region_blocked: "遇到地區限定" };
  var Q_FIELD = {
    id: "題目 id", type: "題型", text: "題目文字", options: "選項", maxSelect: "最多選幾個", maxLength: "字數上限", range: "數字範圍",
    "range.step": "間隔", "range.unit": "單位", "scale.style": "評分樣式", "scale.labels.low": "1 分的說明", "scale.labels.high": "5 分的說明",
    "labels.low": "0 分的說明", "labels.high": "10 分的說明", shuffle: "選項隨機排序", inline: "說明框", required: "必答", showIf: "說明框的條件", next: "出口"
  };
  function describeError(def, e) {
    var qs = isObj(def) && Array.isArray(def.questions) ? def.questions : [];
    var cards = cardsOf(def || {});
    function cardNo(id) { for (var k = 0; k < cards.length; k++) if (cards[k].id === id) return k + 1; return 0; }
    function nameOf(id) {
      var n = cardNo(id);
      if (n) return "第 " + n + " 題（" + id + "）";
      var x = qs.filter(function (q) { return isObj(q) && q.inline && q.id === id; })[0];
      if (!x) return null;
      var pn = x.showIf && cardNo(x.showIf.q);
      return (pn ? "第 " + pn + " 題的" : "") + "說明框（" + id + "）";
    }
    function langPart(seg) { return LANG_NAME[seg] ? "（" + LANG_NAME[seg] + "）" : ""; }
    var msg = String((e && e.message) || "")
      .replace(/(說明框)?「([a-z][a-z0-9_]*)」/g, function (m, pre, id) { var n = nameOf(id); return n ? (pre && n.indexOf("說明框") < 0 ? pre + n : n) : m; })
      .replace(/缺 ([a-zA-Z_]+) 的文字/, function (m, l) { return "缺" + (LANG_NAME[l] || l) + "的文字"; });
    var path = String((e && e.path) || "");
    var m = /^questions\.(\d+)(?:\.(.*))?$/.exec(path);
    if (!m) {
      var segs = path.split("."), label = "";
      if (segs[0] === "title") label = "標題" + langPart(segs[1]);
      else if (segs[0] === "prompt") label = (segs[1] === "invite" ? "頁面邀請" : EVENT_NAME[segs[1]] || segs[1]) + "的說明文字" + langPart(segs[2]);
      else if (segs[0] === "triggers") label = "觸發方式";
      else if (segs[0] === "audience") label = segs[1] === "langs" ? "語言" : "國家";
      else label = { id: "問卷 id", weight: "權重", questions: "題目", layout: "流程圖的版面" }[segs[0]] || "";
      if (label && msg.indexOf("缺") === 0) label = label.replace(/（.*）$/, "");
      return label ? label + "：" + msg : msg;
    }
    var q = qs[+m[1]];
    var who = (isObj(q) && typeof q.id === "string" && nameOf(q.id)) || "第 " + (+m[1] + 1) + " 個題目";
    if (msg.indexOf(who) === 0) return msg; // 訊息本身就從這題開頭（出口、走不到這類）
    var rest = (m[2] || "").split(".").filter(Boolean), sub = "", field = "";
    if (rest[0] === "variants" && rest.length > 1) { sub += "的第 " + (+rest[1] + 1) + " 個國家變體"; rest = rest.slice(2); if (rest[0] === "countries") { field = "國家"; rest = []; } }
    if (rest[0] === "options" && rest.length > 1) {
      sub += "的第 " + (+rest[1] + 1) + " 個選項";
      field = { id: "id", text: "文字" }[rest[2]] || "";
      rest = rest.slice(3);
    }
    else if (rest.length) {
      var key = rest.join("."), lang = "";
      if (LANG_NAME[rest[rest.length - 1]]) { lang = rest[rest.length - 1]; key = rest.slice(0, -1).join("."); }
      field = (isObj(q) && q.inline && key === "text" ? "文字" : Q_FIELD[key] || Q_FIELD[rest[0]]) || "";
      if (field && lang && msg.indexOf(LANG_NAME[lang]) < 0) field += "（" + LANG_NAME[lang] + "）";
      rest = [];
    }
    if (rest.length && LANG_NAME[rest[0]] && field && msg.indexOf(LANG_NAME[rest[0]]) < 0) field += "（" + LANG_NAME[rest[0]] + "）";
    // 欄位名稱接在訊息前面（「題目文字」＋「至少要填一種語言」）；訊息裡已經講到這個欄位就不重複
    var lead = field && msg.indexOf(field.replace(/（.*）$/, "")) < 0 ? field : "";
    return who + sub + "：" + lead + msg;
  }

  // ---- 作答驗證（伺服器收作答時用；def 是 resolve() 過的）----
  function SurveyError(status, code) { this.status = status; this.code = code; this.message = code; }
  SurveyError.prototype = Object.create(Error.prototype);
  SurveyError.prototype.name = "SurveyError";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // 畫面送出前先檢查（跟伺服器同一條規則），格式不對就在畫面上提示，不送出
  function isEmail(s) { s = String(s == null ? "" : s).trim(); return EMAIL_RE.test(s) && s.length <= LIMITS.email; }

  // 回傳 { answers, email }：只留路徑上的題目、Email 抽出來不留在 answers。
  // 路徑照「已經驗證過的答案」一題一題往下走（pathOf 的規則），所以回頭改答案、換了一條路之後，原本那條路上的答案直接丟掉、不驗證
  // （草稿是每答一題送一次，舊路上的答案可能還留在某一次的請求裡；拒收會讓使用者送不出去，所以丟掉就好）。
  // 不認得的題目 id 一律拒收。final（按了送出）時路徑上的必答題都要有答案。不合格丟 SurveyError(400, …)
  function cleanAnswers(def, raw, final) {
    if (!isObj(raw)) throw new SurveyError(400, "bad_answers");
    var qs = def.questions || [];
    var known = {};
    qs.forEach(function (q) { known[q.id] = q; });
    Object.keys(raw).forEach(function (k) { if (!known[k]) throw new SurveyError(400, "bad_answer"); });
    var kept = {}, email = null;
    function bad() { throw new SurveyError(400, "bad_answer"); }
    // 依路徑順序：卡片、接著它下面的說明框（下一張卡片、說明框出不出現，都看已經驗證過的答案 kept）
    var onPath = [];
    walkCards(def, kept, function (q) {
      clean(q);
      onPath.push(q);
      inlineOf(def, q.id).forEach(function (x) { if (isVisible(x, kept)) { clean(x); onPath.push(x); } });
    });
    function clean(q) {
      var v = raw[q.id];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
      var ids = (q.options || []).map(function (o) { return o.id; });
      if (q.type === "single") {
        if (typeof v !== "string" || !inList(ids, v)) bad();
        kept[q.id] = v;
      } else if (q.type === "multi") {
        if (!Array.isArray(v) || v.some(function (x) { return typeof x !== "string" || !inList(ids, x); })) bad();
        var uniq = v.filter(function (x, i) { return v.indexOf(x) === i; });
        if (q.maxSelect != null && uniq.length > q.maxSelect) bad();
        kept[q.id] = uniq;
      } else if (q.type === "rank") {
        // 排序：每個選項剛好出現一次
        if (!Array.isArray(v) || v.length !== ids.length || v.some(function (x, i) { return typeof x !== "string" || !inList(ids, x) || v.indexOf(x) !== i; })) bad();
        kept[q.id] = v.slice();
      } else if (q.type === "email") {
        var s = typeof v === "string" ? v.trim().toLowerCase() : "";
        if (!isEmail(s)) throw new SurveyError(400, "bad_email");
        email = s;
      } else if (q.type === "text" || q.type === "longtext") {
        if (typeof v !== "string") bad();
        var max = q.maxLength || (q.inline ? LIMITS.inline : LIMITS[q.type]);
        var str = v.trim();
        if (str.length > max) bad();
        if (str) kept[q.id] = str;
      } else if (q.type === "rating" || q.type === "nps") {
        var lo = q.type === "rating" ? 1 : 0, hi = q.type === "rating" ? 5 : 10;
        if (!Number.isInteger(v) || v < lo || v > hi) bad();
        kept[q.id] = v;
      } else if (q.type === "number") {
        var r = q.range || {};
        if (typeof v !== "number" || !isFinite(v) || v < r.min || v > r.max) bad();
        if (r.step) { var n = (v - r.min) / r.step; if (Math.abs(n - Math.round(n)) > 1e-9) bad(); }
        kept[q.id] = v;
      }
    }
    if (final) {
      onPath.forEach(function (q) {
        if (!q.required) return;
        if (q.type === "email" ? !email : !hasAnswer(kept[q.id])) throw new SurveyError(400, "incomplete");
      });
    }
    return { answers: kept, email: email };
  }

  // 自動附帶的欄位（入口、瀏覽器、擴充版本、介面語言、安裝天數分組、有沒有用自訂節點）
  function cleanClient(entry, client) {
    if (!inList(ENTRIES, entry)) throw new SurveyError(400, "bad_entry");
    var c = isObj(client) ? client : {};
    if (!inList(BROWSERS, c.browser) || typeof c.ext_version !== "string" || !c.ext_version || c.ext_version.length > 16 ||
        !inList(LANGS, c.lang) || !inList(INSTALL_DAYS, c.install_days) || typeof c.custom_nodes !== "boolean") throw new SurveyError(400, "bad_client");
    return { entry: entry, browser: c.browser, ext_version: c.ext_version, lang: c.lang, install_days: c.install_days, custom_nodes: c.custom_nodes ? 1 : 0 };
  }

  var api = {
    LANGS: LANGS, TYPES: TYPES, CHOICE_TYPES: CHOICE_TYPES, FIELD_TYPES: FIELD_TYPES, AUTO_NEXT_TYPES: AUTO_NEXT_TYPES, EVENTS: EVENTS, ENTRIES: ENTRIES,
    BROWSERS: BROWSERS, INSTALL_DAYS: INSTALL_DAYS, LIMITS: LIMITS, BASE_EXT_VERSION: BASE_EXT_VERSION, FEATURE_SINCE: FEATURE_SINCE,
    pick: pick, asArray: asArray, hasAnswer: hasAnswer, isVisible: isVisible, pagesOf: pagesOf, inlineOf: inlineOf, opensInline: opensInline,
    END: END, BRANCH_TYPES: BRANCH_TYPES, cardsOf: cardsOf, exitsOf: exitsOf, nextOf: nextOf, pathOf: pathOf, pathIds: pathIds, checkFlow: checkFlow, lockedChanges: lockedChanges, describeError: describeError,
    optionOrder: optionOrder, cmpVersion: cmpVersion, minExtVersion: minExtVersion, audienceMatch: audienceMatch, resolve: resolve,
    validateDefinition: validateDefinition, isEmail: isEmail,
    optionLists: optionLists, cleanAnswers: cleanAnswers, cleanClient: cleanClient, SurveyError: SurveyError
  };
  // Worker 與後台用 import 載入（模組裡的 var 不會變成全域），所以明確掛到 globalThis
  globalThis.BBSurveyCore = api;
  // Test seam: only the unit-test harness (test/helpers/load.mjs) defines __BCS_TEST__.
  if (globalThis.__BCS_TEST__ && typeof globalThis.__BCS_TEST__.register === "function") globalThis.__BCS_TEST__.register("survey-core", api);
  return api;
})();
