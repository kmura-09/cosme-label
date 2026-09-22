// golden.json の期待値 (処方 → 成分表 / テキスト解析 / 規制引き当て / 突合) と
// js/label.js の出力が一致することを検証する。  node test/run.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import {
  buildIngredientLabel, parseFormulaText, indexRegulatoryRows, resolveRegulatoryLimits, checkRegulatory, LabelError,
} from "../js/label.js";
import { parseCsvRecords, toCsv } from "../js/csv.js";
import { MaterialStore, IngredientStore } from "../js/store.js";
import { splitFormulaLines, normKey, compileFreeClaims, checkFreeClaims } from "../js/label.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "golden.json"), "utf8"));
const regTable = indexRegulatoryRows(JSON.parse(readFileSync(join(here, "../data/regulatory_limits_inci.json"), "utf8")));

let n = 0;
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6, `${msg}: ${a} vs ${b}`);

for (const c of golden.label_cases) {
  const opts = {
    thresholdPct: c.options.threshold_pct, normalize: c.options.normalize,
    displayNames: c.options.display_names, colorants: c.options.colorants,
  };
  if (c.expected_error) {
    assert.throws(() => buildIngredientLabel(c.formula, c.materials, opts), LabelError, c.name);
    n++; continue;
  }
  const res = buildIngredientLabel(c.formula, c.materials, opts);
  const exp = c.expected;
  assert.equal(res.entries.length, exp.entries.length, `${c.name}: entry count`);
  exp.entries.forEach((e, i) => {
    const r = res.entries[i];
    assert.equal(r.inciName, e.inci, `${c.name}: order at ${i}`);
    approx(r.pct, e.pct, `${c.name}: pct ${e.inci}`);
    assert.equal(r.displayName, e.display, `${c.name}: display ${e.inci}`);
    assert.equal(r.unorderedOk, e.unordered_ok, `${c.name}: unordered ${e.inci}`);
    assert.equal(r.isColorant, e.is_colorant, `${c.name}: colorant ${e.inci}`);
    assert.deepEqual(Object.keys(r.sources).sort(), Object.keys(e.sources).sort(), `${c.name}: sources ${e.inci}`);
  });
  approx(res.totalPct, exp.total_pct, `${c.name}: total`);
  approx(res.labeledPct, exp.labeled_pct, `${c.name}: labeled`);
  assert.equal(res.warnings.length, exp.n_warnings, `${c.name}: warnings ${JSON.stringify(res.warnings)}`);
  assert.equal(res.asText(), exp.jp_text, `${c.name}: jp text`);
  assert.equal(res.asInciText(), exp.inci_text, `${c.name}: inci text`);
  n++;
}

for (const c of golden.parse_cases) {
  assert.deepEqual(parseFormulaText(c.text), c.expected, "parse: " + JSON.stringify(c.text));
  n++;
}

for (const c of golden.regulatory_cases) {
  const r = resolveRegulatoryLimits(regTable, c.inci_names, { productClass: c.product_class, jurisdictions: c.jurisdictions });
  assert.deepEqual(r.individual, c.expected.individual, `reg individual ${c.product_class}/${c.jurisdictions}`);
  assert.deepEqual(r.groups.map((g) => [g.groupName, g.members, g.limitPct]), c.expected.groups, `reg groups ${c.product_class}/${c.jurisdictions}`);
  n++;
}

{
  const c = golden.check_case;
  const res = buildIngredientLabel(c.formula, c.materials);
  const r = resolveRegulatoryLimits(regTable, res.inciOrder, { productClass: c.product_class, jurisdictions: c.jurisdictions });
  const f = checkRegulatory(res, r).map((x) => ({ inci: x.inciName, pct: x.pct, limit: x.limitPct, exceeded: x.exceeded, group: x.groupName }));
  assert.deepEqual(f, c.expected, "check_regulatory");
  n++;
}

// CSV roundtrip + store (in-memory storage)
{
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const st = new MaterialStore(storage);
  const csv = readFileSync(join(here, "../data/sample_materials.csv"), "utf8");
  const { saved, errors } = st.importCsv(csv);
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(saved.length, 33);
  const back = parseCsvRecords(st.exportCsv());
  assert.equal(back.length, parseCsvRecords(csv).length, "csv roundtrip rows");
  const sles = st.getByName("sles-27");
  assert.ok(sles && sles.components.length === 2);
  assert.throws(() => st.save({ name: "Bad", components: [{ inci: "X", pct: 70 }, { inci: "Y", pct: 40 }] }), /超えて/);
  const rt = parseCsvRecords(toCsv([{ a: 'x,"y"', b: "line\nbreak" }], ["a", "b"]));
  assert.deepEqual(rt, [{ a: 'x,"y"', b: "line\nbreak" }]);
  n += 3;
}

// IngredientStore
{
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const ing = new IngredientStore(storage);
  ing.save({ inci: "Water", display_name: "水" });
  assert.equal(ing.get("  water ").display_name, "水");
  const n1 = ing.absorb([{ inci: "Water", display_name: "みず" }, { inci: "Glycerin", display_name: "グリセリン" }, { inci: "CI 77491", display_name: null, is_colorant: true }]);
  assert.equal(n1, 2);                                   // Water は既存で上書きしない
  assert.equal(ing.get("Water").display_name, "水");
  assert.deepEqual(ing.displayNames(), { Water: "水", Glycerin: "グリセリン" });
  assert.deepEqual([...ing.colorants()], ["CI 77491"]);
  const back = new IngredientStore(storage);             // 永続化
  assert.equal(back.count(), 3);
  const csv = parseCsvRecords(ing.exportCsv());
  assert.equal(csv.length, 3);
  assert.ok(ing.delete("glycerin") && !ing.get("Glycerin"));
  // 工業会風の日本語ヘッダ
  const jp = ing.importRows(parseCsvRecords("表示名称,INCI名,定義\nラウレス硫酸Na,Sodium Laureth Sulfate,陰イオン界面活性剤\n"));
  assert.equal(jp.errors.length, 0);
  assert.equal(ing.get("Sodium Laureth Sulfate").display_name, "ラウレス硫酸Na");
  assert.equal(ing.get("Sodium Laureth Sulfate").note, "陰イオン界面活性剤");
  // 表記揺れの吸収と表示名称からの逆引き
  assert.equal(ing.get("ＷＡＴＥＲ").inci, "Water");
  ing.save({ inci: "Ceteareth-20", display_name: "セテアレス-20" });
  assert.equal(ing.get("ceteareth 20").inci, "Ceteareth-20");
  assert.equal(ing.getByDisplayName("水").inci, "Water");
  // 同じ表示名称に別 INCI → 成分表で警告
  const dup = buildIngredientLabel({ A: 50, B: 50 }, { A: { Water: 100 }, B: { Aqua: 100 } }, { displayNames: { Water: "水", Aqua: "水" } });
  assert.ok(dup.warnings.some((w) => w.includes("Water / Aqua")), dup.warnings.join("|"));
  n += 9;
}

// ── スペース入り原料名 / 末尾数字の原料名 / INCI 表記揺れ ────────────────────
{
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const st = new MaterialStore(storage);
  st.save({ name: "MCT オイル", components: [{ inci: "Caprylic/Capric Triglyceride", pct: 100 }] });
  st.save({ name: "ポリソルベート 80", components: [{ inci: "Polysorbate 80", pct: 100 }] });
  st.save({ name: "精製水", components: [{ inci: "Water", pct: 100 }] });
  st.save({ name: "乳化剤 A", components: [{ inci: "Ceteareth-20", pct: 30 }, { inci: "Cetearyl  Alcohol", pct: 70 }] });
  st.save({ name: "乳化剤 B", components: [{ inci: "Ceteareth 20", pct: 100 }] });

  // parsePastedLine 相当 (app.js は DOM 依存なので同じ規則をここで検証)
  const parseLine = (line) => (st.getByName(line) ? [line, null] : parseFormulaText(line)[0]);
  assert.deepEqual(parseLine("MCT オイル\t4"), ["MCT オイル", 4]);            // スペース入り原料名 + タブ
  assert.deepEqual(parseLine("MCT オイル 4"), ["MCT オイル", 4]);              // スペース区切り
  assert.deepEqual(parseLine("ポリソルベート 80 2"), ["ポリソルベート 80", 2]); // 末尾数字の原料名 + %
  assert.deepEqual(parseLine("ポリソルベート 80"), ["ポリソルベート 80", null]); // % 無し → 誤読しない
  assert.deepEqual(parseLine("ポリソルベート 80%"), ["ポリソルベート", 80]);    // % 記号があれば配合%
  assert.deepEqual(splitFormulaLines("a 1\n\n# c\nb 2; c 3"), ["a 1", "b 2", "c 3"]);

  // 原料名の照合は前後空白と大小だけ無視 (中のスペースは保持)
  assert.equal(st.getByName("  mct オイル ").name, "MCT オイル");
  assert.equal(st.getByName("MCTオイル"), null);

  // 成分表: INCI の空白連続 / ハイフン↔空白 / 全角は同一 INCI として合算
  const mats = Object.fromEntries(st.listAll().map((m) => [m.name, Object.fromEntries(m.components.map((c) => [c.inci, c.pct]))]));
  const res = buildIngredientLabel({ "乳化剤 A": 50, "乳化剤 B": 50, "精製水": 0 }, mats);
  assert.deepEqual(res.inciOrder, ["Ceteareth-20", "Cetearyl  Alcohol"]);
  assert.equal(res.entries[0].pct, 65);                                          // 15 + 50 合算 (表記は最初に見た方)
  assert.equal(normKey("ＣＥＴＥＡＲＥＴＨ－２０"), normKey("ceteareth 20"));
  n += 12;
}

// フリー表示チェック (ルール JSON を共有、期待値は golden)
{
  const claims = compileFreeClaims(JSON.parse(readFileSync(join(here, "../data/free_claims.json"), "utf8")));
  for (const c of golden.free_claim_cases) {
    const got = checkFreeClaims(c.inci_names, claims, { colorants: c.colorants }).map((x) => ({ id: x.id, status: x.status, ng: x.ng, caution: x.caution }));
    assert.deepEqual(got, c.expected, "free claims: " + c.inci_names.slice(0, 3).join(","));
    n++;
  }
}

console.log(`ok: ${n} checks passed`);
