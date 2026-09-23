// 成分表 (全成分表示) 生成の純ロジック。DOM や保存に依存しない ES module
// (ブラウザ / Node 両用)。期待値は test/golden.json、検証は test/run.mjs。
//
// 表示順の規則:
//   1. 配合量の多い順 (質量% 降順)
//   2. 閾値 (既定 1%) 以下は順不同帯 → unorderedOk=true。1% 超より後ろに置く
//   3. 着色剤は配合量に関わらず末尾 (colorants に含めた INCI のみ)
// 同率は入力順を保つ安定ソート。

export const DEFAULT_THRESHOLD_PCT = 1.0;
const TOTAL_TOL = 0.5;          // 処方合計が 100 からこれ以上ずれたら警告
const MATERIAL_SUM_TOL = 0.05;  // 原料構成が 100% からこれ以上不足したら警告

// 照合キー: NFKC (全角→半角)、大小無視、空白の連続とハイフン/空白の揺れ (Ceteareth-20 /
// Ceteareth 20) を吸収。表示は最初に見た表記のまま。
export function normKey(name) {
  return String(name ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s\-‐‑–—]+/g, " ");
}

function round(x, decimals) {
  const f = 10 ** decimals;
  return Math.round((x + Number.EPSILON) * f) / f;
}

function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export class LabelError extends Error {}

/**
 * 処方と原料構成から全成分表示を組み立てる。
 * @param {Object<string, number>} formula  {原料名: 配合%}
 * @param {Object<string, Object<string, number>>} materials {原料名: {INCI: 原料中%}}
 * @param {Object} [opts]
 * @param {number} [opts.thresholdPct=1]   順不同帯の閾値 (%)
 * @param {Object<string,string>|null} [opts.displayNames=null] {INCI: 表示名称}
 * @param {Iterable<string>|null} [opts.colorants=null] 末尾に送る INCI
 * @param {boolean} [opts.normalize=false] 合計を 100 に正規化
 * @param {number} [opts.decimals=4]
 */
export function buildIngredientLabel(formula, materials, opts = {}) {
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const displayNames = opts.displayNames ?? null;
  const colorants = opts.colorants ?? null;
  const normalize = opts.normalize ?? false;
  const decimals = opts.decimals ?? 4;
  if (thresholdPct < 0) throw new LabelError("threshold_pct は 0 以上");

  const warnings = [];
  const notes = [];

  const items = Object.entries(formula)
    .map(([k, v]) => [String(k).trim(), Number(v)])
    .filter(([k]) => k);
  if (!items.length) throw new LabelError("処方が空です");
  for (const [name, pct] of items) {
    if (!(pct >= 0)) throw new LabelError(`配合% が負か数値でありません: ${name} = ${pct}`);
  }
  const total = items.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) throw new LabelError("処方の合計が 0 です");

  let scale = 1.0;
  if (Math.abs(total - 100) > TOTAL_TOL) {
    if (normalize) {
      scale = 100 / total;
      notes.push(`処方合計 ${total.toFixed(2)}% を 100% に正規化しました`);
    } else {
      const d = total - 100;
      warnings.push(
        `処方の合計が ${total.toFixed(2)}% です (100% に対し ${d >= 0 ? "+" : ""}${d.toFixed(2)}%)。` +
        "成分表の % は入力値のまま計算しています");
    }
  }

  const matIndex = new Map(Object.keys(materials).map((k) => [normKey(k), k]));
  const inciPct = new Map();       // normKey → %
  const inciDisplayKey = new Map(); // normKey → 最初に見た表記
  const sources = new Map();       // normKey → Map(原料名 → 寄与%)
  const seen = new Set();

  for (const [matName, matPct] of items) {
    const key = normKey(matName);
    if (seen.has(key)) warnings.push(`処方に同じ原料が複数回あります: ${matName} (合算しました)`);
    seen.add(key);
    if (!matIndex.has(key)) throw new LabelError(`原料が未登録です: ${matName}`);
    const comp = materials[matIndex.get(key)] || {};
    const entries = Object.entries(comp);
    if (!entries.length) {
      warnings.push(`原料 ${matName} に構成成分が登録されていません`);
      continue;
    }
    const compTotal = entries.reduce((s, [, v]) => s + Number(v), 0);
    if (compTotal > 100 + MATERIAL_SUM_TOL) {
      throw new LabelError(`原料 ${matName} の構成比合計が 100% を超えています (${compTotal.toFixed(2)}%)`);
    }
    if (compTotal < 100 - MATERIAL_SUM_TOL) {
      const missing = (100 - compTotal) * matPct * scale / 100;
      warnings.push(
        `原料 ${matName} の構成比は ${compTotal.toFixed(2)}% で 100% に足りません。` +
        `不足分 ${missing.toFixed(3)}% (処方換算) は成分表に載りません`);
    }
    for (const [inci, frac] of entries) {
      const inciS = String(inci).trim();
      if (!inciS) continue;
      const contrib = matPct * scale * Number(frac) / 100;
      if (!(contrib > 0)) continue;
      const ikey = normKey(inciS);
      if (!inciDisplayKey.has(ikey)) inciDisplayKey.set(ikey, inciS);
      inciPct.set(ikey, (inciPct.get(ikey) || 0) + contrib);
      if (!sources.has(ikey)) sources.set(ikey, new Map());
      const src = sources.get(ikey);
      src.set(matName, (src.get(matName) || 0) + contrib);
    }
  }
  if (!inciPct.size) throw new LabelError("成分表に載る成分がありません (全原料の構成が空か 0)");

  const colorKeys = new Set([...(colorants || [])].map(normKey));
  const dispIndex = new Map();
  for (const [k, v] of Object.entries(displayNames || {})) if (v) dispIndex.set(normKey(k), v);

  const rows = [...inciPct.entries()].map(([ikey, pct], order) => ({ ikey, pct: round(pct, decimals), order }));
  const main = rows.filter((r) => !colorKeys.has(r.ikey));
  const colors = rows.filter((r) => colorKeys.has(r.ikey));
  const cmp = (a, b) => (b.pct - a.pct) || (a.order - b.order);
  main.sort(cmp);
  colors.sort(cmp);

  const entriesOut = [];
  for (const r of [...main, ...colors]) {
    const src = {};
    for (const [k, v] of sources.get(r.ikey)) src[k] = round(v, decimals);
    entriesOut.push({
      position: entriesOut.length + 1,
      inciName: inciDisplayKey.get(r.ikey),
      pct: r.pct,
      displayName: dispIndex.get(r.ikey) ?? null,
      sources: src,
      unorderedOk: r.pct <= thresholdPct,
      isColorant: colorKeys.has(r.ikey),
    });
  }

  for (const e of entriesOut) {
    const n = Object.keys(e.sources).length;
    if (n > 1) {
      notes.push(`${e.inciName} は ${n} 原料に由来し合算しました: ` +
        Object.entries(e.sources).map(([k, v]) => `${k} ${v.toFixed(3)}%`).join(", "));
    }
  }
  const unnamed = entriesOut.filter((e) => e.displayName == null).map((e) => e.inciName);
  if (displayNames !== null && unnamed.length) {
    warnings.push("表示名称が引けず INCI 名で代用: " + unnamed.join(", "));
  }
  // 同じ表示名称に別 INCI が 2 行以上 (Water / Aqua 等の表記揺れ) → 二重計上の疑い
  const byDisp = new Map();
  for (const e of entriesOut) if (e.displayName) { const k = e.displayName.normalize("NFKC"); if (!byDisp.has(k)) byDisp.set(k, []); byDisp.get(k).push(e.inciName); }
  for (const [d, incis] of byDisp) if (incis.length > 1) {
    warnings.push(`表示名称「${d}」に別々の INCI が ${incis.length} 行あります (${incis.join(" / ")})。同じ成分なら INCI 表記を統一してください`);
  }
  const nUnordered = entriesOut.filter((e) => e.unorderedOk && !e.isColorant).length;
  if (nUnordered) {
    notes.push(`${thresholdPct}% 以下の ${nUnordered} 成分は順不同で記載できます (本表は降順に並べています)`);
  }
  if (colors.length) notes.push(`着色剤 ${colors.length} 成分は配合量に関わらず末尾にまとめました`);
  notes.push("香料の一括表記・キャリーオーバー成分の省略・部外品の有効成分表記などの法規判断は" +
    "本表に含みません。最終的な表示は担当者が確認してください");

  const labeled = entriesOut.reduce((s, e) => s + e.pct, 0);
  const result = {
    entries: entriesOut,
    totalPct: round(total * scale, decimals),
    labeledPct: round(labeled, decimals),
    warnings,
    notes,
    thresholdPct,
  };
  result.inciOrder = entriesOut.map((e) => e.inciName);
  result.asText = (sep = "、") => entriesOut.map((e) => e.displayName || e.inciName).join(sep);
  result.asInciText = (sep = ", ") => entriesOut.map((e) => e.inciName).join(sep);
  result.unnamedInci = () => unnamed.slice();
  return result;
}

// ── テキスト処方の解析 ─────────────────────────────────────────────────────

const NAME_PCT_RE = /^(.+?)[\s,、:：]+(\d+(?:\.\d+)?)\s*%?\s*$/;
const PCT_NAME_RE = /^(\d+(?:\.\d+)?)\s*%?[\s,、:：]+(.+?)\s*$/;
const STRIP = " \t,、:：";

/** 貼り付けテキストを行に分ける (改行 / セミコロン区切り、NFKC、空行とコメント除去)。 */
export function splitFormulaLines(text) {
  return String(text ?? "").split(/[\r\n;；]+/).map((l) => l.normalize("NFKC").trim()).filter((l) => l && !l.startsWith("#"));
}

/** 「原料名 配合%」の行 (改行 / セミコロン区切り) を [[name, pct|null], ...] にする。 */
export function parseFormulaText(text) {
  const out = [];
  for (const line of splitFormulaLines(text)) {
    let m = NAME_PCT_RE.exec(line);
    if (m) {
      const name = stripChars(m[1], STRIP);
      if (name) { out.push([name, parseFloat(m[2])]); continue; }
    }
    m = PCT_NAME_RE.exec(line);
    if (m) {
      const name = stripChars(m[2], STRIP);
      if (name) { out.push([name, parseFloat(m[1])]); continue; }
    }
    out.push([stripChars(line, STRIP + "%"), null]);
  }
  return out;
}

// ── 着色剤 ─────────────────────────────────────────────────────────────────

const CI_NUMBER_RE = /^CI\s*\d{5}(?:\s*\(.*\))?$/i;
export function isCiNumber(name) {
  return CI_NUMBER_RE.test(String(name ?? "").trim());
}

// ── 規制上限 (INCI 名キー JSON) ─────────────────────────────────────────────
// 最緩 (loosest) 集約: 地域未指定なら全地域の max、剤型未指定なら全 scope、剤型確定なら
// 'any' + 該当ファミリのみ。禁止は上限 0 として扱い、他に許容があればそちらが勝つ。

const RINSE_SCOPES = new Set(["rinse_off", "rinse_off_shampoo", "rinse_off_non_mucosa", "soap", "antidandruff_shampoo"]);
const LEAVE_SCOPES = new Set(["leave_on", "leave_on_except_oral", "leave_on_non_mucosa"]);
const ANY_SCOPE = "any";

function applicableScopes(productClass) {
  if (productClass == null) return null;
  if (productClass === "rinse_off") return new Set([...RINSE_SCOPES, ANY_SCOPE]);
  if (productClass === "leave_on") return new Set([...LEAVE_SCOPES, ANY_SCOPE]);
  throw new LabelError(`product_class は 'rinse_off'/'leave_on'/null: ${productClass}`);
}

/** JSON (export_regulatory_json.py の出力) を {normKey(INCI): [row]} にする。 */
export function indexRegulatoryRows(data) {
  const rows = Array.isArray(data) ? data : (data?.rows || []);
  const table = new Map();
  for (const r of rows) {
    const k = normKey(r.inci_name);
    if (!table.has(k)) table.set(k, []);
    table.get(k).push(r);
  }
  return table;
}

export function resolveRegulatoryLimits(table, inciNames, { productClass = null, jurisdictions = null } = {}) {
  const scopes = applicableScopes(productClass);
  const jset = jurisdictions && jurisdictions.length ? new Set(jurisdictions.map((j) => j.toUpperCase())) : null;
  const individual = {};
  const groupAcc = new Map();
  const seenJur = new Set();

  for (const name of inciNames) {
    const rows = table.get(normKey(name)) || [];
    if (!rows.length) continue;
    let indivBest = null;
    for (const r of rows) {
      if (jset && !jset.has(r.jurisdiction)) continue;
      if (scopes && !scopes.has(r.product_scope || ANY_SCOPE)) continue;
      seenJur.add(r.jurisdiction);
      if (r.limit_basis === "group_total" && r.group_name) {
        const lim = r.limit_pct_max;
        if (lim == null) continue;
        if (!groupAcc.has(r.group_name)) groupAcc.set(r.group_name, { limit: lim, members: new Set() });
        const acc = groupAcc.get(r.group_name);
        acc.limit = Math.max(acc.limit, lim);
        acc.members.add(name);
      } else {
        const lim = r.limit_basis === "prohibited" ? 0 : r.limit_pct_max;
        if (lim == null) continue;
        indivBest = indivBest == null ? lim : Math.max(indivBest, lim);
      }
    }
    if (indivBest != null) individual[name] = indivBest;
  }
  const groups = [...groupAcc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([groupName, acc]) => ({
      groupName, members: [...acc.members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), limitPct: acc.limit,
    }));
  const notes = [];
  if (productClass == null) notes.push("剤型 (rinse-off / leave-on) 未指定のため全 scope の最緩上限を採用しています。剤型を与えると微量域の上限が締まります。");
  if (!jset) notes.push("地域未指定のため JP/EU/US/KR の最緩上限を採用しています (どの市場の製品でも満たす保守側)。");
  return { individual, groups, jurisdictions: jset ? [...jset].sort() : [...seenJur].sort(), productClass, notes };
}

/** 成分表の % を規制上限と突き合わせる。上限のある成分だけ返す (超過が先頭)。 */
export function checkRegulatory(label, resolved) {
  const byKey = new Map(label.entries.map((e) => [normKey(e.inciName), e]));
  const findings = [];
  for (const [inci, limit] of Object.entries(resolved.individual || {})) {
    const e = byKey.get(normKey(inci));
    if (!e) continue;
    if (limit == null || limit <= 0) findings.push({ inciName: e.inciName, pct: e.pct, limitPct: null, exceeded: true, groupName: null });
    else findings.push({ inciName: e.inciName, pct: e.pct, limitPct: limit, exceeded: e.pct > limit + 1e-9, groupName: null });
  }
  for (const g of resolved.groups || []) {
    const members = g.members.map((m) => byKey.get(normKey(m))).filter(Boolean);
    if (!members.length) continue;
    const total = members.reduce((s, m) => s + m.pct, 0);
    const exceeded = total > g.limitPct + 1e-9;
    for (const m of members) {
      findings.push({ inciName: m.inciName, pct: round(total, 4), limitPct: g.limitPct, exceeded, groupName: g.groupName });
    }
  }
  findings.sort((a, b) => (Number(!a.exceeded) - Number(!b.exceeded)) || (a.inciName < b.inciName ? -1 : a.inciName > b.inciName ? 1 : 0));
  return findings;
}

export function findingText(f) {
  if (f.limitPct == null) return `${f.inciName}: 配合禁止に該当 (${f.pct.toFixed(3)}%)`;
  const scope = f.groupName ? `グループ「${f.groupName}」合算` : "個別上限";
  return `${f.inciName}: ${f.pct.toFixed(3)}% / ${scope} ${f.limitPct}% → ${f.exceeded ? "超過" : "以内"}`;
}

// ── 「〇〇フリー」表示の根拠チェック ─────────────────────────────────────────
// data/free_claims.json のルール (ng / caution / exclude の正規表現) を INCI 名に当てる。
// status: "ok" (該当なし) / "ng" (該当あり = 表示不可) / "caution" (定義次第、要確認)。

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 利用者の簡易指定 ({text, mode:"exact"|"contains"}) を正規表現文字列に。 */
export function termToPattern(term) {
  const t = String(term.text ?? "").normalize("NFKC").trim();
  if (!t) return null;
  return term.mode === "contains" ? escapeRe(t) : `^${escapeRe(t)}$`;
}

/**
 * 同梱ルール (data) に利用者設定 (rules) を重ねた「有効なルール」を返す。
 * rules = { disabled: [id], overrides: { id: { ng: [term], caution: [term], exclude: [term] } },
 *           custom: [{ id, label, description, ng: [term], caution: [term], exclude: [term] }] }
 * 同梱ルールの組み込みパターンは消せない (壊せない)。追加と除外だけできる。
 */
export function applyClaimRules(data, rules) {
  const r = rules || {};
  const disabled = new Set(r.disabled || []);
  const terms = (arr) => (arr || []).map(termToPattern).filter(Boolean);
  const claims = [];
  for (const c of data.claims || []) {
    if (disabled.has(c.id)) continue;
    const o = (r.overrides || {})[c.id] || {};
    // 利用者の追加 (forceNg / forceCaution) は組み込みの除外より優先、利用者の除外は組み込みの該当より優先
    claims.push({ ...c, forceNg: terms(o.ng), forceCaution: terms(o.caution),
      exclude: [...(c.exclude || []), ...terms(o.exclude)], builtin: true });
  }
  for (const c of r.custom || []) {
    if (!c.id || !c.label || disabled.has(c.id)) continue;
    claims.push({ id: c.id, label: c.label, description: c.description || "", ng: terms(c.ng), caution: terms(c.caution), exclude: terms(c.exclude), builtin: false });
  }
  return { ...data, claims };
}

/** 規制データの行から EU Annex ごとの INCI 集合 {"IV": Set, "V": Set, "VI": Set} を作る。 */
export function regulatoryAnnexSets(rows) {
  const sets = {};
  for (const r of Array.isArray(rows) ? rows : (rows?.rows || [])) {
    const m = /Annex (I{1,3}|IV|V|VI)\b/.exec(r.regulation_citation || "");
    if (!m) continue;
    (sets[m[1]] ||= new Set()).add(r.inci_name);
  }
  return sets;
}

/** claim.regulatory_annex に従い、Annex の一覧を完全一致パターンとして ng/caution に足す (網羅性の第二の根拠)。 */
export function applyRegulatoryAnnexes(data, annexSets) {
  const claims = (data.claims || []).map((c) => {
    if (!c.regulatory_annex) return c;
    const add = (kind) => (c.regulatory_annex[kind] || []).flatMap((a) => [...(annexSets[a] || [])]).map((n) => `^${escapeRe(n.normalize("NFKC"))}$`);
    return { ...c, ng: [...(c.ng || []), ...add("ng")], caution: [...(c.caution || []), ...add("caution")] };
  });
  return { ...data, claims };
}

export function compileFreeClaims(data) {
  const rx = (arr) => (arr || []).map((p) => new RegExp(p, "i"));
  return (data.claims || []).map((c) => ({
    id: c.id, label: c.label, description: c.description || "", method: c.method || "list",
    ng: rx(c.ng), caution: rx(c.caution), exclude: rx(c.exclude),
    forceNg: rx(c.forceNg), forceCaution: rx(c.forceCaution),
    purposes: c.purposes || {},
  }));
}

/**
 * @param {Object} [opts]
 * @param {Iterable<string>|null} [opts.colorants]  原料側で着色剤にした INCI
 * @param {(inci:string)=>string|null} [opts.purposeOf]  成分辞書の配合目的 (規則に掛からなくても目的が一致すれば要確認)
 */
export function checkFreeClaims(inciNames, claims, { colorants = null, purposeOf = null } = {}) {
  const colorKeys = new Set([...(colorants || [])].map(normKey));
  const names = inciNames.map((n) => ({ raw: n, s: String(n).normalize("NFKC").trim() }));
  return claims.map((c) => {
    const ng = [], caution = [], purposeHits = [];
    const cautionPurposes = new Set(c.purposes?.caution || []);
    for (const { raw, s } of names) {
      if (c.forceNg.some((r) => r.test(s))) { ng.push(raw); continue; }
      if (c.forceCaution.some((r) => r.test(s))) { caution.push(raw); continue; }
      if (c.exclude.some((r) => r.test(s))) continue;
      if (c.ng.some((r) => r.test(s)) || (c.id === "colorant_free" && colorKeys.has(normKey(raw)))) { ng.push(raw); continue; }
      if (c.caution.some((r) => r.test(s))) { caution.push(raw); continue; }
      const purpose = purposeOf ? purposeOf(raw) : null;
      if (purpose && cautionPurposes.has(purpose)) { caution.push(raw); purposeHits.push({ inci: raw, purpose }); }
    }
    return { id: c.id, label: c.label, description: c.description, method: c.method, status: ng.length ? "ng" : caution.length ? "caution" : "ok", ng, caution, purposeHits };
  });
}

/** 原料の配列から成分表生成の 3 入力 (構成 / 表示名称 / 着色剤) をまとめる。 */
export function labelInputs(materials) {
  const comp = {}, names = {}, colorants = new Set();
  for (const m of materials) {
    comp[m.name] = {};
    for (const c of m.components) {
      comp[m.name][c.inci] = Number(c.pct);
      if (c.display_name && !(c.inci in names)) names[c.inci] = c.display_name;
      if (c.is_colorant || isCiNumber(c.inci)) colorants.add(c.inci);
    }
  }
  return { materials: comp, displayNames: names, colorants };
}

// ── 自然由来指数 (ISO 16128 の考え方) と配合成分の訴求点候補 ─────────────────
// info: (inciName) => { purpose, origin, natural_index } | null  (成分辞書からの引き当て)

/**
 * 成分表の各行 (pct) と辞書の天然由来率から、処方全体の自然由来指数を出す。
 * 未登録成分は 0 とみなした下限と 100 とみなした上限の幅で返す (正直な範囲)。
 * 水を含む値と除く値の両方を返す (業界慣行で両方併記されるため)。
 */
export function naturalOriginIndex(entries, info) {
  const calc = (rows) => {
    let total = 0, known = 0, weighted = 0; const missing = [];
    for (const e of rows) {
      total += e.pct;
      const i = info(e.inciName);
      const ni = i && i.natural_index != null ? Number(i.natural_index) : null;
      if (ni == null) { missing.push(e.inciName); continue; }
      known += e.pct; weighted += e.pct * ni / 100;
    }
    if (total <= 0) return { low: null, high: null, coverage: 0, missing };
    const low = 100 * weighted / total;                 // 未登録 = 0
    const high = 100 * (weighted + (total - known)) / total; // 未登録 = 100
    return { low: round(low, 1), high: round(high, 1), coverage: round(100 * known / total, 1), missing };
  };
  const isWater = (n) => /^(water|aqua|eau)$/i.test(n.trim()) || n.trim() === "水";
  return { withWater: calc(entries), withoutWater: calc(entries.filter((e) => !isWater(e.inciName))) };
}

// 訴求にならない配合目的・由来 (処方上の都合や否定的なもの) は候補から外し、補足にまとめる
export const NON_PROMOTABLE_PURPOSES = new Set(["基剤", "溶剤", "pH調整剤", "キレート剤", "防腐剤", "増粘剤", "乳化剤", "可溶化剤", "乳化安定剤",
  "皮膜形成剤", "着色剤", "香料", "パール剤", "感触調整剤", "酸化防止剤"]);
export const NON_PROMOTABLE_ORIGINS = new Set(["水", "合成", "石油由来", "動物由来"]);

/** 配合目的・由来ごとに成分をまとめ、「目的：成分・成分」型の候補を作る。 */
export function ingredientClaims(entries, info, { skipPurposes = NON_PROMOTABLE_PURPOSES, skipOrigins = NON_PROMOTABLE_ORIGINS } = {}) {
  const byPurpose = new Map(), byOrigin = new Map(), other = new Map(), unknown = [];
  for (const e of entries) {
    const i = info(e.inciName); const name = e.displayName || e.inciName;
    if (!i || (!i.purpose && !i.origin)) { unknown.push(name); continue; }
    if (i.purpose) {
      const target = skipPurposes.has(i.purpose) ? other : byPurpose;
      if (!target.has(i.purpose)) target.set(i.purpose, []); target.get(i.purpose).push(name);
    }
    if (i.origin && !skipOrigins.has(i.origin)) { if (!byOrigin.has(i.origin)) byOrigin.set(i.origin, []); byOrigin.get(i.origin).push(name); }
  }
  const purposeLines = [...byPurpose].map(([p, names]) => ({ purpose: p, names, text: `${p}：${names.join("・")}` }));
  const originLines = [...byOrigin].map(([o, names]) => ({ origin: o, names, text: `${o}成分 ${names.length} 種：${names.join("・")}` }));
  const otherLines = [...other].map(([p, names]) => `${p} ${names.length}`);
  return { purposeLines, originLines, otherLines, unknown };
}
