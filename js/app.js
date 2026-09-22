// 画面の配線。ロジックは label.js、保存は store.js。
import {
  buildIngredientLabel, parseFormulaText, indexRegulatoryRows, resolveRegulatoryLimits,
  checkRegulatory, findingText, labelInputs, isCiNumber, LabelError,
} from "./label.js";
import { MaterialStore, IngredientStore, totalPct, CSV_COLUMNS } from "./store.js";
import { parseCsvRecords } from "./csv.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const alertBox = (msg, kind = "warn") => el("div", { class: `alert ${kind}` }, msg);

const store = new MaterialStore();
const ingredients = new IngredientStore();
let regTable = new Map();
fetch("data/regulatory_limits_inci.json").then((r) => r.json()).then((d) => { regTable = indexRegulatoryRows(d); renderLabel(); })
  .catch(() => { $("#label-output").prepend(alertBox("規制データ (data/regulatory_limits_inci.json) を読めませんでした。規制チェックなしで動作します。", "warn")); });

// ── タブ ────────────────────────────────────────────────────────────────────
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
  if (t.dataset.tab === "label") { renderMaterialDatalist(); renderFormula(); }
  if (t.dataset.tab === "ingredients") renderIngredientList();
  if (t.dataset.tab === "materials") renderInciDatalist();
}));

// ═══════════════════════ 成分表生成 ═══════════════════════
const FKEY = "cosme-label:formula:v1";
let formula = (() => { try { return JSON.parse(sessionStorage.getItem(FKEY) || "[]"); } catch { return []; } })();
const persistFormula = () => { try { sessionStorage.setItem(FKEY, JSON.stringify(formula)); } catch { /* ignore */ } };

function resolveMaterialName(name) {
  const m = store.getByName(name);
  if (m) return { name: m.name, candidates: [] };
  const hits = store.search(name, 10);
  if (hits.length === 1) return { name: hits[0].name, candidates: [] };
  return { name: null, candidates: hits.map((h) => h.name) };
}

function applyPasted(text) {
  const parsed = parseFormulaText(text);
  const fb = $("#paste-feedback"); fb.replaceChildren();
  if (!parsed.length) { fb.append(alertBox("解析できる行がありません")); return; }
  const rows = [], problems = [];
  for (const [name, pct] of parsed) {
    const { name: resolved, candidates } = resolveMaterialName(name);
    if (pct == null) { problems.push(`「${name}」: 配合% が読めません`); continue; }
    if (!resolved) { problems.push(`「${name}」: 原料を特定できません${candidates.length ? ` (候補: ${candidates.join(", ")})` : " (未登録)"}`); continue; }
    const ex = rows.find((r) => r.material === resolved);
    if (ex) ex.pct = Math.round((ex.pct + pct) * 1e4) / 1e4; else rows.push({ material: resolved, pct });
  }
  if (problems.length) {
    fb.append(el("div", { class: `alert ${rows.length ? "warn" : "danger"}` },
      el("div", {}, `${rows.length} 原料を反映、${problems.length} 行は未反映:`),
      el("ul", {}, problems.map((p) => el("li", {}, p)))));
  } else fb.append(alertBox(`${rows.length} 原料を反映しました`, "success"));
  if (rows.length) { formula = rows; persistFormula(); renderFormula(); }
}

$("#paste-btn").addEventListener("click", () => applyPasted($("#paste-input").value));
for (const [id, file] of [["#sample-shampoo-btn", "sample_formula_shampoo.txt"], ["#sample-cream-btn", "sample_formula_cream.txt"]]) {
  $(id).addEventListener("click", async () => {
    if (!store.count()) { $("#paste-feedback").replaceChildren(alertBox("先に原料登録タブで「サンプル原料を読込」を実行してください")); return; }
    const t = await (await fetch(`data/${file}`)).text();
    $("#paste-input").value = t; applyPasted(t);
  });
}

$("#add-btn").addEventListener("click", () => {
  const name = $("#add-material").value.trim(); const pct = parseFloat($("#add-pct").value);
  const fb = $("#paste-feedback"); fb.replaceChildren();
  if (!name || !(pct >= 0)) { fb.append(alertBox("原料と配合% を入力してください")); return; }
  const { name: resolved, candidates } = resolveMaterialName(name);
  if (!resolved) { fb.append(alertBox(`原料を特定できません: ${name}${candidates.length ? ` (候補: ${candidates.join(", ")})` : ""}`, "danger")); return; }
  const ex = formula.find((r) => r.material === resolved);
  if (ex) ex.pct = Math.round((ex.pct + pct) * 1e4) / 1e4; else formula.push({ material: resolved, pct });
  $("#add-material").value = ""; $("#add-pct").value = "";
  persistFormula(); renderFormula();
});
$("#clear-formula-btn").addEventListener("click", () => { formula = []; persistFormula(); renderFormula(); });

function renderMaterialDatalist() {
  $("#material-list").replaceChildren(...store.listAll().map((m) => el("option", { value: m.name }, m.maker ? `[${m.maker}]` : "")));
}

function renderFormula() {
  const tb = $("#formula-table tbody"); tb.replaceChildren();
  formula.forEach((r, i) => {
    const m = store.getByName(r.material);
    const comp = m ? m.components.map((c) => `${c.inci} ${c.pct}%`).join(" / ") : "(未登録)";
    tb.append(el("tr", {},
      el("td", {}, r.material),
      el("td", { class: "small" }, comp),
      el("td", { class: "num" }, el("input", { type: "number", min: 0, max: 100, step: 0.01, value: r.pct,
        onchange: (e) => { const v = parseFloat(e.target.value); if (v >= 0) { formula[i].pct = v; persistFormula(); renderLabel(); updateTotal(); } } })),
      el("td", {}, el("button", { class: "ghost danger", onclick: () => { formula.splice(i, 1); persistFormula(); renderFormula(); } }, "✕")),
    ));
  });
  updateTotal(); renderLabel();
}
function updateTotal() {
  const total = formula.reduce((s, r) => s + Number(r.pct || 0), 0);
  const b = $("#formula-total"); const d = total - 100;
  b.textContent = formula.length ? `合計: ${total.toFixed(2)}%${Math.abs(d) > 0.5 ? ` (${d >= 0 ? "+" : ""}${d.toFixed(2)}%)` : ""}` : "0%";
  b.className = "badge " + (!formula.length ? "" : Math.abs(d) <= 0.5 ? "ok" : "warn");
}

function options() {
  return {
    threshold: parseFloat($("#opt-threshold").value) || 0,
    colorantsLast: $("#opt-colorants").checked,
    normalize: $("#opt-normalize").checked,
    productClass: $("#opt-product-class").value || null,
    jurisdictions: $$(".opt-jur:checked").map((x) => x.value),
  };
}
["#opt-threshold", "#opt-colorants", "#opt-normalize", "#opt-product-class"].forEach((s) => $(s).addEventListener("change", renderLabel));
$$(".opt-jur").forEach((x) => x.addEventListener("change", renderLabel));

function copyBlock(title, text, id) {
  const pre = el("pre", { class: "copy", id }, text);
  const btn = el("button", { onclick: async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = "コピーしました"; }
    catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(r); btn.textContent = "選択しました (Ctrl/Cmd+C)"; }
    setTimeout(() => { btn.textContent = "コピー"; }, 1500);
  } }, "コピー");
  return [el("div", { class: "copyhead" }, title, btn), pre];
}

function renderLabel() {
  const out = $("#label-output"); out.replaceChildren();
  const rows = formula.filter((r) => Number(r.pct) > 0);
  if (!rows.length) { out.append(el("p", { class: "muted" }, "左で原料と配合% を入力すると、ここに全成分表示の順で成分表が出ます。")); return; }
  const o = options();
  const mats = [];
  for (const r of rows) {
    const m = store.getByName(r.material);
    if (!m) { out.append(alertBox(`原料が未登録です: ${r.material}`, "danger")); return; }
    mats.push(m);
  }
  const inputs = labelInputs(mats);
  const materials = inputs.materials;
  const displayNames = { ...ingredients.displayNames(), ...inputs.displayNames };
  const colorants = new Set([...ingredients.colorants(), ...inputs.colorants]);
  const f = Object.fromEntries(rows.map((r) => [r.material, Number(r.pct)]));
  let res;
  try {
    res = buildIngredientLabel(f, materials, { thresholdPct: o.threshold, normalize: o.normalize, displayNames,
      colorants: o.colorantsLast ? colorants : null });
  } catch (e) {
    out.append(alertBox(e instanceof LabelError ? e.message : `エラー: ${e.message}`, "danger")); return;
  }
  const resolved = resolveRegulatoryLimits(regTable, res.inciOrder, { productClass: o.productClass, jurisdictions: o.jurisdictions.length ? o.jurisdictions : null });
  const findings = checkRegulatory(res, resolved);

  const head = el("div", { class: "row gap" },
    el("h2", { style: "margin:0" }, "成分表 (全成分表示)"),
    el("span", { class: "badge" }, `${res.entries.length} 成分`),
    el("span", { class: `badge ${Math.abs(res.labeledPct - 100) <= 0.5 ? "ok" : "warn"}` }, `記載計 ${res.labeledPct.toFixed(2)}%`));
  out.append(head);
  res.warnings.forEach((w) => out.append(alertBox(w, "warn")));
  const exceeded = findings.filter((x) => x.exceeded), within = findings.filter((x) => !x.exceeded);
  if (exceeded.length) out.append(el("div", { class: "alert danger" }, el("b", {}, "⚠ 規制上限の超過 / 禁止該当"), el("ul", {}, exceeded.map((x) => el("li", {}, findingText(x))))));
  if (within.length) out.append(el("div", { class: "alert info" }, el("b", {}, "規制上限あり (以内)"), el("ul", {}, within.map((x) => el("li", {}, findingText(x))))));

  out.append(el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "表示名称 / INCI"), el("th", { class: "num" }, "%"), el("th", {}, "由来原料 (寄与%)"), el("th", {}, "備考"))),
    el("tbody", {}, res.entries.map((e) => el("tr", {},
      el("td", {}, e.position),
      el("td", {}, e.displayName || e.inciName, e.displayName ? el("span", { class: "sub" }, e.inciName) : null),
      el("td", { class: "num" }, e.pct.toFixed(3)),
      el("td", { class: "small" }, Object.entries(e.sources).map(([k, v]) => `${k} (${+v.toPrecision(3)})`).join(" / ")),
      el("td", { class: "flag" }, e.isColorant ? "着色剤" : e.unorderedOk ? "順不同可" : ""))))));
  out.append(...copyBlock("表示名称 (日本語)", res.asText(), "jp-text"));
  out.append(...copyBlock("INCI (英語)", res.asInciText(), "inci-text"));
  out.append(el("ul", { class: "notes" }, res.notes.map((n) => el("li", {}, n))));
  const pcText = o.productClass || "指定なし (最も緩い上限)";
  out.append(el("p", { class: "muted small" },
    `規制照会: 剤型 ${pcText} / 地域 ${o.jurisdictions.length ? o.jurisdictions.join(", ") : "全地域 (最緩)"}。${resolved.notes.join(" ")} 規制は改正されるため、最新の規制原文を必ず確認してください。`));
}

// ═══════════════════════ 原料登録 ═══════════════════════
let edit = { id: null, components: [] };
let selectedId = null;

function renderMaterialList() {
  const q = $("#mat-search").value.trim();
  const list = q ? store.search(q, 500) : store.listAll();
  const tb = $("#mat-table tbody"); tb.replaceChildren();
  for (const m of list) {
    tb.append(el("tr", { class: m.id === selectedId ? "selected" : "", onclick: () => { selectedId = m.id; loadMaterial(m); renderMaterialList(); } },
      el("td", {}, m.name), el("td", { class: "small" }, m.maker || ""),
      el("td", { class: "num" }, m.components.length), el("td", { class: "num" }, totalPct(m).toFixed(2))));
  }
  $("#mat-count").textContent = store.count();
}
$("#mat-search").addEventListener("input", renderMaterialList);

function loadMaterial(m) {
  edit = { id: m.id, components: m.components.map((c) => ({ ...c })) };
  $("#mat-name").value = m.name; $("#mat-maker").value = m.maker || ""; $("#mat-note").value = m.note || "";
  $("#mat-edit-title").textContent = "原料の編集"; $("#mat-edit-feedback").replaceChildren();
  renderComponents();
}
function newMaterial() {
  edit = { id: null, components: [] }; selectedId = null;
  $("#mat-name").value = ""; $("#mat-maker").value = ""; $("#mat-note").value = "";
  $("#mat-edit-title").textContent = "原料の新規登録"; $("#mat-edit-feedback").replaceChildren();
  renderComponents(); renderMaterialList();
}
$("#mat-new-btn").addEventListener("click", newMaterial);

function renderComponents() {
  const tb = $("#comp-table tbody"); tb.replaceChildren();
  edit.components.forEach((c, i) => {
    tb.append(el("tr", {},
      el("td", {}, el("input", { value: c.inci, placeholder: "INCI 名", list: "inci-list", oninput: (e) => renderInciDatalist(e.target.value), onchange: (e) => {
        c.inci = e.target.value.trim();
        const known = ingredients.get(c.inci);
        if (known) { c.inci = known.inci; if (!c.display_name && known.display_name) c.display_name = known.display_name; if (known.is_colorant) c.is_colorant = true; }
        if (isCiNumber(c.inci)) c.is_colorant = true;
        renderComponents();
      } })),
      el("td", {}, el("input", { value: c.display_name || "", placeholder: "表示名称 (任意)", onchange: (e) => { c.display_name = e.target.value.trim() || null; } })),
      el("td", { class: "num" }, el("input", { type: "number", min: 0, max: 100, step: 0.01, value: c.pct ?? "", onchange: (e) => { c.pct = parseFloat(e.target.value); updateCompTotal(); } })),
      el("td", {}, el("input", { type: "checkbox", ...(c.is_colorant ? { checked: "" } : {}), onchange: (e) => { c.is_colorant = e.target.checked; } })),
      el("td", {}, el("button", { class: "ghost danger", onclick: () => { edit.components.splice(i, 1); renderComponents(); } }, "✕")),
    ));
  });
  updateCompTotal();
}
function updateCompTotal() {
  const b = $("#comp-total");
  if (!edit.components.length) { b.textContent = "成分なし"; b.className = "badge"; return; }
  const t = edit.components.reduce((s, c) => s + (Number(c.pct) || 0), 0); const d = t - 100;
  b.textContent = `構成計: ${t.toFixed(2)}%${Math.abs(d) > 0.05 ? ` (${d >= 0 ? "+" : ""}${d.toFixed(2)}%)` : ""}`;
  b.className = "badge " + (Math.abs(d) <= 0.05 ? "ok" : d > 0 ? "bad" : "warn");
}
$("#comp-add-btn").addEventListener("click", () => { edit.components.push({ inci: "", display_name: null, pct: null, is_colorant: false }); renderComponents(); $("#comp-table tbody tr:last-child input").focus(); });

$("#mat-save-btn").addEventListener("click", () => {
  const fb = $("#mat-edit-feedback"); fb.replaceChildren();
  try {
    const saved = store.save({ id: edit.id, name: $("#mat-name").value, maker: $("#mat-maker").value, note: $("#mat-note").value, components: edit.components });
    const absorbed = ingredients.absorb(saved.components);
    selectedId = saved.id; loadMaterial(saved); renderMaterialList(); renderInciDatalist();
    fb.append(alertBox(`保存しました: ${saved.name} (${saved.components.length} 成分, 構成計 ${totalPct(saved).toFixed(2)}%)` +
      (absorbed ? ` / 成分マスタに ${absorbed} 件追加` : ""), "success"));
  } catch (e) { fb.append(alertBox(e.message, "danger")); }
});
$("#mat-del-btn").addEventListener("click", () => {
  const m = selectedId && store.get(selectedId);
  if (!m) { $("#mat-list-feedback").replaceChildren(alertBox("一覧で原料を選択してください")); return; }
  if (!confirm(`「${m.name}」を削除しますか?`)) return;
  store.delete(m.id); $("#mat-list-feedback").replaceChildren(alertBox(`削除しました: ${m.name}`, "success")); newMaterial();
});
$("#mat-clear-btn").addEventListener("click", () => {
  if (!store.count() || !confirm(`登録済み原料 ${store.count()} 件をすべて削除しますか? (JSON 書出でバックアップを推奨)`)) return;
  store.clear(); newMaterial(); $("#mat-list-feedback").replaceChildren(alertBox("全削除しました", "success"));
});

function download(name, text, type = "text/plain") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
$("#mat-export-csv").addEventListener("click", () => download("raw_materials.csv", store.exportCsv(), "text/csv"));
$("#mat-export-json").addEventListener("click", () => download("raw_materials.json", store.exportJson(), "application/json"));
function reportImport({ saved, errors }, label) {
  const fb = $("#mat-list-feedback"); fb.replaceChildren();
  let absorbed = 0;
  for (const m of saved) absorbed += ingredients.absorb(m.components);
  renderInciDatalist();
  fb.append(alertBox(`${label}: ${saved.length} 原料を取り込みました${absorbed ? ` / 成分マスタに ${absorbed} 件追加` : ""}`, errors.length ? "warn" : "success"));
  if (errors.length) fb.append(el("div", { class: "alert danger" }, el("b", {}, `${errors.length} 件は取り込めませんでした:`), el("ul", {}, errors.map((x) => el("li", {}, x)))));
  newMaterial();
}
function readFile(input, cb) {
  const f = input.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { cb(rd.result); } catch (e) { $("#mat-list-feedback").replaceChildren(alertBox(`取込失敗: ${e.message}`, "danger")); } input.value = ""; };
  rd.readAsText(f);
}
$("#mat-import-csv").addEventListener("change", (e) => readFile(e.target, (t) => {
  const recs = parseCsvRecords(t);
  const missing = ["name", "inci_name", "pct"].filter((c) => !(c in (recs[0] || {})));
  if (missing.length) throw new Error(`列が足りません: ${missing.join(", ")} (必要: ${CSV_COLUMNS.slice(0, 5).join(", ")} …)`);
  reportImport(store.importRows(recs), "CSV 取込");
}));
$("#mat-import-json").addEventListener("change", (e) => readFile(e.target, (t) => reportImport(store.importJson(t), "JSON 取込")));
$("#mat-sample-btn").addEventListener("click", async () => {
  const t = await (await fetch("data/sample_materials.csv")).text();
  reportImport(store.importCsv(t), "サンプル原料");
});

// ═══════════════════════ 成分登録 ═══════════════════════
let ingEdit = null; // 編集中の INCI (元のキー)

function renderInciDatalist(q = "") {
  // 1 万件超の辞書でも重くならないよう、入力中の文字列に合う 50 件だけを候補にする
  $("#inci-list").replaceChildren(...ingredients.search(q, 50).map((x) => el("option", { value: x.inci }, x.display_name || "")));
}
function renderIngredientList() {
  const q = $("#ing-search").value.trim();
  const all = q ? ingredients.search(q, 100000) : ingredients.listAll();
  const LIMIT = 300;
  const list = all.slice(0, LIMIT);
  const tb = $("#ing-table tbody"); tb.replaceChildren();
  if (all.length > LIMIT) tb.append(el("tr", {}, el("td", { colspan: 4, class: "small muted" }, `${all.length} 件中 ${LIMIT} 件を表示。検索で絞り込んでください。`)));
  for (const x of list) {
    tb.append(el("tr", { class: ingEdit && IngredientStore.key(ingEdit) === IngredientStore.key(x.inci) ? "selected" : "", onclick: () => loadIngredient(x) },
      el("td", {}, x.inci), el("td", {}, x.display_name || el("span", { class: "muted" }, "(未設定)")),
      el("td", {}, x.is_colorant ? "✓" : ""), el("td", { class: "small" }, x.note || "")));
  }
  $("#ing-count").textContent = ingredients.count();
}
$("#ing-search").addEventListener("input", renderIngredientList);
function loadIngredient(x) {
  ingEdit = x.inci;
  $("#ing-inci").value = x.inci; $("#ing-display").value = x.display_name || "";
  $("#ing-colorant").checked = !!x.is_colorant; $("#ing-note").value = x.note || "";
  $("#ing-edit-title").textContent = "成分の編集"; $("#ing-edit-feedback").replaceChildren();
  renderIngredientList();
}
function newIngredient() {
  ingEdit = null;
  ["#ing-inci", "#ing-display", "#ing-note"].forEach((id) => { $(id).value = ""; });
  $("#ing-colorant").checked = false; $("#ing-edit-title").textContent = "成分の登録"; $("#ing-edit-feedback").replaceChildren();
  renderIngredientList();
}
$("#ing-new-btn").addEventListener("click", newIngredient);
$("#ing-save-btn").addEventListener("click", () => {
  const fb = $("#ing-edit-feedback"); fb.replaceChildren();
  try {
    const inci = $("#ing-inci").value.trim();
    if (ingEdit && IngredientStore.key(ingEdit) !== IngredientStore.key(inci)) ingredients.delete(ingEdit); // INCI 名の変更
    const saved = ingredients.save({ inci, display_name: $("#ing-display").value, is_colorant: $("#ing-colorant").checked || isCiNumber(inci), note: $("#ing-note").value });
    loadIngredient(saved); renderInciDatalist(); renderLabel();
    fb.append(alertBox(`保存しました: ${saved.inci}${saved.display_name ? ` → ${saved.display_name}` : ""}`, "success"));
  } catch (e) { fb.append(alertBox(e.message, "danger")); }
});
$("#ing-del-btn").addEventListener("click", () => {
  if (!ingEdit) { $("#ing-edit-feedback").replaceChildren(alertBox("一覧で成分を選択してください")); return; }
  if (!confirm(`「${ingEdit}」を成分マスタから削除しますか? (原料側の構成は変わりません)`)) return;
  ingredients.delete(ingEdit); newIngredient(); renderInciDatalist(); renderLabel();
});
$("#ing-absorb-btn").addEventListener("click", () => {
  let n = 0; for (const m of store.listAll()) n += ingredients.absorb(m.components);
  renderIngredientList(); renderInciDatalist();
  $("#ing-list-feedback").replaceChildren(alertBox(`登録済み原料から ${n} 件を取り込みました`, "success"));
});
$("#ing-clear-btn").addEventListener("click", () => {
  if (!ingredients.count() || !confirm(`成分マスタ ${ingredients.count()} 件をすべて削除しますか?`)) return;
  ingredients.clear(); newIngredient(); renderInciDatalist(); renderLabel();
});
$("#ing-export-csv").addEventListener("click", () => download("ingredients.csv", ingredients.exportCsv(), "text/csv"));
$("#ing-import-csv").addEventListener("change", (e) => readFile(e.target, (t) => {
  const recs = parseCsvRecords(t);
  if (!recs.length || IngredientStore.normalizeRow(recs[0]).inci === undefined) throw new Error("INCI 名の列が見つかりません (inci_name / INCI名 など。任意: display_name / 表示名称, is_colorant, note)");
  const { saved, errors } = ingredients.importCsv(t);
  const fb = $("#ing-list-feedback"); fb.replaceChildren();
  fb.append(alertBox(`CSV 取込: ${saved.length} 成分`, errors.length ? "warn" : "success"));
  if (errors.length) fb.append(el("div", { class: "alert danger" }, el("ul", {}, errors.map((x) => el("li", {}, x)))));
  newIngredient(); renderInciDatalist(); renderLabel();
}));

// ── 初期描画 ────────────────────────────────────────────────────────────────
renderMaterialList(); renderComponents(); renderMaterialDatalist(); renderInciDatalist(); renderIngredientList(); renderFormula();
