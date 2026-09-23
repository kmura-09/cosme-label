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
import { splitFormulaLines, normKey, compileFreeClaims, checkFreeClaims, applyClaimRules, termToPattern, naturalOriginIndex, ingredientClaims } from "../js/label.js";
import { ClaimRuleStore } from "../js/store.js";
import { buildClaimPrompt, promptAsText, EFFICACY_56, chatLinks } from "../js/copy.js";

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

// 利用者ルール (オンオフ / 追加 / 除外 / 自作) の適用
{
  const data = JSON.parse(readFileSync(join(here, "../data/free_claims.json"), "utf8"));
  assert.equal(termToPattern({ text: "Polysorbate 80", mode: "exact" }), "^Polysorbate 80$");
  assert.equal(termToPattern({ text: "(Wheat)", mode: "contains" }), "\\(Wheat\\)");
  const rules = {
    disabled: ["urea_free"],
    overrides: { peg_free: { exclude: [{ text: "Polysorbate 80", mode: "exact" }] }, silicone_free: { ng: [{ text: "Silica Silylate", mode: "exact" }] } },
    custom: [{ id: "custom_x", label: "合成ポリマーフリー", ng: [{ text: "carbomer", mode: "contains" }, { text: "Acrylates", mode: "contains" }] }],
  };
  const claims = compileFreeClaims(applyClaimRules(data, rules));
  const by = Object.fromEntries(checkFreeClaims(["Polysorbate 80", "Laureth-7", "Silica Silylate", "Carbomer", "Urea"], claims).map((r) => [r.id, r]));
  assert.ok(!("urea_free" in by), "disabled claim removed");
  assert.deepEqual(by.peg_free.ng, ["Laureth-7"], "excluded polysorbate");       // 除外が効く
  assert.deepEqual(by.silicone_free.ng, ["Silica Silylate"], "user-added ng beats builtin exclude");
  assert.deepEqual(by.custom_x.ng, ["Carbomer"]);
  // ストア
  const mem = new Map(); const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const st = new ClaimRuleStore(storage);
  st.setEnabled("urea_free", false); st.setOverride("peg_free", { exclude: [{ text: "Polysorbate 80", mode: "exact" }] });
  const c = st.saveCustom({ label: "合成ポリマーフリー", ng: [{ text: "carbomer", mode: "contains" }] });
  const back = new ClaimRuleStore(storage);
  assert.ok(back.isDisabled("urea_free") && back.custom(c.id).label === "合成ポリマーフリー" && back.override("peg_free").exclude.length === 1);
  back.importJson(st.exportJson()); assert.equal(back.rules.custom.length, 1);
  back.resetAll(); assert.equal(new ClaimRuleStore(storage).rules.custom.length, 0);
  n += 8;
}

// 自然由来指数と配合成分の訴求候補
{
  const entries = [
    { inciName: "Water", displayName: "水", pct: 70 }, { inciName: "Glycerin", displayName: "グリセリン", pct: 10 },
    { inciName: "Simmondsia Chinensis (Jojoba) Seed Oil", displayName: "ホホバ種子油", pct: 10 }, { inciName: "Dimethicone", displayName: "ジメチコン", pct: 10 },
  ];
  const dict = { water: { purpose: "基剤", origin: "水", natural_index: 100 }, glycerin: { purpose: "保湿剤", origin: null, natural_index: null },
    "simmondsia chinensis (jojoba) seed oil": { purpose: "エモリエント剤", origin: "植物由来", natural_index: 100 }, dimethicone: { purpose: "エモリエント剤", origin: "合成", natural_index: 0 } };
  const info = (n) => dict[normKey(n)] || null;
  const noi = naturalOriginIndex(entries, info);
  // 水含む: 既知 90% のうち天然 80 → 下限 80, 上限 90 (グリセリン未登録 10%)
  assert.deepEqual([noi.withWater.low, noi.withWater.high, noi.withWater.coverage, noi.withWater.missing], [80, 90, 90, ["Glycerin"]]);
  // 水除く: 30% 中 既知 20 (ホホバ 10 天然, ジメチコン 10 合成) → 下限 33.3, 上限 66.7
  assert.deepEqual([noi.withoutWater.low, noi.withoutWater.high], [33.3, 66.7]);
  const ic = ingredientClaims(entries, info);
  assert.deepEqual(ic.purposeLines.map((l) => l.text), ["保湿剤：グリセリン", "エモリエント剤：ホホバ種子油・ジメチコン"]);
  assert.deepEqual(ic.originLines.map((l) => l.text), ["植物由来成分 1 種：ホホバ種子油"]);   // 水・合成は訴求にしない
  assert.deepEqual(ic.otherLines, ["基剤 1"]);
  assert.deepEqual(ic.unknown, []);
  // 辞書 CSV: 日本語ヘッダ + 空欄だけ埋める上書き
  const mem = new Map(); const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const ing = new IngredientStore(storage);
  ing.importRows(parseCsvRecords("INCI名,表示名称,配合目的,由来,天然由来率\nGlycerin,グリセリン,保湿剤,植物由来,100\n"));
  assert.deepEqual([ing.get("Glycerin").purpose, ing.get("Glycerin").origin, ing.get("Glycerin").natural_index], ["保湿剤", "植物由来", 100]);
  ing.importRows(parseCsvRecords("inci_name,display_name\nGlycerin,グリセリン(別)\n"));
  assert.equal(ing.get("Glycerin").purpose, "保湿剤");          // 目的は消えない
  assert.equal(ing.get("Glycerin").display_name, "グリセリン(別)");
  assert.equal(parseCsvRecords(ing.exportCsv())[0].natural_index, "100");
  n += 9;
}

// 訴求文プロンプト
{
  assert.equal(EFFICACY_56.length, 56);
  const facts = { jpText: "水、グリセリン", inciText: "Water, Glycerin", entries: [{ name: "グリセリン", pct: 12.345, purpose: "保湿剤", origin: "" }, { name: "水", pct: 87.655 }],
    candidates: ["保湿剤：グリセリン"], naturalIndex: "90.0%（水を含む）", freeClaims: ["パラベンフリー"] };
  const p = buildClaimPrompt(facts, { productName: "テスト化粧水", mode: "cosmetic" });
  assert.ok(p.system.includes("56 項目") && p.system.includes("乾燥による小ジワを目立たなくする"));
  assert.ok(p.user.includes("テスト化粧水") && p.user.includes("保湿剤：グリセリン") && p.user.includes("パラベンフリー"));
  // 機密: 配合% はどのモードでも絶対に含めない
  for (const mode of ["cosmetic", "quasi_drug", "free"]) for (const compact of [false, true]) {
    const t = promptAsText(buildClaimPrompt(facts, { mode, compact }));
    assert.ok(!t.includes("12.345") && !t.includes("87.655") && !/\d+(\.\d+)?%/.test(t.replace(/自然由来指数[^\n]*/g, "")), `pct leaked (${mode}, compact=${compact})`);
  }
  assert.ok(p.user.includes("配合量は非開示"));
  const q = buildClaimPrompt(facts, { mode: "free" });
  assert.ok(!q.system.includes("56 項目") && q.system.includes("事実を作らない"));
  assert.ok(promptAsText(p).includes("---"));
  const short = promptAsText(buildClaimPrompt(facts, { mode: "cosmetic", compact: true }));
  assert.ok(!short.includes("乾燥による小ジワ") && short.includes("56 項目"));
  const links = chatLinks(short);
  assert.ok(links.every((l) => !l.tooLong) && links[0].href.startsWith("https://chatgpt.com/?q=") && links[1].href.startsWith("https://claude.ai/new?q="));
  n += 6;
}

console.log(`ok: ${n} checks passed`);
