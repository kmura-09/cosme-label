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

export function normKey(name) {
  return String(name ?? "").trim().split(/\s+/).filter(Boolean).join(" ").toLowerCase();
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

/** 「原料名 配合%」の行 (改行 / セミコロン区切り) を [[name, pct|null], ...] にする。 */
export function parseFormulaText(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/[\r\n;；]+/)) {
    const line = raw.normalize("NFKC").trim();
    if (!line || line.startsWith("#")) continue;
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
