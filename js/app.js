// 画面の配線。ロジックは label.js、保存は store.js。
import {
  buildIngredientLabel, parseFormulaText, splitFormulaLines, indexRegulatoryRows, resolveRegulatoryLimits,
  checkRegulatory, findingText, labelInputs, isCiNumber, LabelError, compileFreeClaims, checkFreeClaims, applyClaimRules,
  naturalOriginIndex, ingredientClaims, normKey,
} from "./label.js?v=202609231536";
import { MaterialStore, IngredientStore, ClaimRuleStore, ORIGINS, totalPct, CSV_COLUMNS } from "./store.js?v=202609231536";
import { buildClaimPrompt, promptAsText, chatLinks } from "./copy.js";
import { parseCsvRecords } from "./csv.js?v=202609231536";

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

const DISCLAIMER_TEXT = "本ツールおよび同梱の規制データは情報提供のみを目的とし、法的助言ではありません。規制データは公的文書を基に作成していますが、正確性・完全性・最新性を保証しません。規制は改正され、製品の分類・適用部位・地域によって適用される規定は異なります。成分表示および配合上限の適合性の最終判断は、利用者の責任において最新の規制原文および専門家の確認に基づいて行ってください。本ツールの利用により生じたいかなる損害についても、作者は責任を負いません。";
const store = new MaterialStore();
const ingredients = new IngredientStore();
let regTable = new Map();
let freeClaims = [], claimData = { claims: [] };
const ruleStore = new ClaimRuleStore();
function rebuildClaims() { freeClaims = compileFreeClaims(applyClaimRules(claimData, ruleStore.rules)); }
fetch("data/free_claims.json").then((r) => r.json()).then((d) => { claimData = d; rebuildClaims(); renderLabel(); renderRuleList(); }).catch(() => {});
fetch("data/regulatory_limits_inci.json").then((r) => r.json()).then((d) => { regTable = indexRegulatoryRows(d); renderLabel(); })
  .catch(() => { $("#label-output").prepend(alertBox("規制データ (data/regulatory_limits_inci.json) を読めませんでした。規制チェックなしで動作します。", "warn")); });

// ── タブ ────────────────────────────────────────────────────────────────────
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
  if (t.dataset.tab === "label") { renderMaterialDatalist(); renderFormula(); }
  if (t.dataset.tab === "ingredients") renderIngredientList();
  if (t.dataset.tab === "materials") renderInciDatalist();
  if (t.dataset.tab === "rules") renderRuleList();
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

/** 1 行を (原料名, %) に分ける。行全体が登録原料名に一致するなら「% 無し」とみなす
 *  (「ポリソルベート 80」のような末尾数字の原料名を「ポリソルベート 80%」と誤読しない)。 */
export function parsePastedLine(line, store_ = store) {
  if (store_.getByName(line)) return [line, null];
  const [[name, pct]] = parseFormulaText(line);
  return [name, pct];
}

let lastPasteText = "";
function applyPasted(text, { offerRegister = true } = {}) {
  lastPasteText = text;
  const lines = splitFormulaLines(text);
  const fb = $("#paste-feedback"); fb.replaceChildren();
  if (!lines.length) { fb.append(alertBox("解析できる行がありません")); return; }
  const rows = [], problems = [], unregistered = [];
  for (const line of lines) {
    const [name, pct] = parsePastedLine(line);
    const { name: resolved, candidates } = resolveMaterialName(name);
    if (pct == null) { problems.push(`「${name}」: 配合% が読めません`); continue; }
    if (!resolved && !candidates.length) { unregistered.push({ name, pct }); continue; }
    if (!resolved) { problems.push(`「${name}」: 原料を特定できません (候補: ${candidates.join(", ")})`); continue; }
    const ex = rows.find((r) => r.material === resolved);
    if (ex) ex.pct = Math.round((ex.pct + pct) * 1e4) / 1e4; else rows.push({ material: resolved, pct });
  }
  const allProblems = problems.concat(unregistered.map((u) => `「${u.name}」: 未登録`));
  if (allProblems.length) {
    fb.append(el("div", { class: `alert ${rows.length ? "warn" : "danger"}` },
      el("div", {}, `${rows.length} 原料を反映、${allProblems.length} 行は未反映:`),
      el("ul", {}, allProblems.map((p) => el("li", {}, p)))));
  } else fb.append(alertBox(`${rows.length} 原料を反映しました`, "success"));
  if (rows.length) { formula = rows; persistFormula(); renderFormula(); }
  if (unregistered.length) {
    fb.append(el("div", { class: "row gap" },
      el("button", { class: "primary", onclick: () => openRegisterDialog(unregistered) }, `未登録の ${unregistered.length} 原料を登録`),
      el("span", { class: "muted small" }, "登録が終わると処方に自動で反映されます")));
    if (offerRegister) openRegisterDialog(unregistered);  // 初回は自動で開く。中断後は再度ボタンで
  }
}

// ── 貼り付け時の未登録原料をその場で登録するウィンドウ ────────────────────────
const regDialog = $("#reg-dialog");
let regQueue = [], regTotal = 0, regEdit = null, regDone = 0;
function renderRegComponents() { renderComponentTable($("#reg-comp-table tbody"), $("#reg-comp-total"), regEdit.components, renderRegComponents); }
function openRegisterDialog(items) {
  regQueue = items.slice(); regTotal = items.length; regDone = 0;
  nextRegItem();
  if (!regDialog.open) { if (typeof regDialog.showModal === "function") regDialog.showModal(); else regDialog.setAttribute("open", ""); }
}
function nextRegItem() {
  $("#reg-feedback").replaceChildren();
  if (!regQueue.length) { finishRegister(); return; }
  const item = regQueue[0];
  regEdit = { name: item.name, components: [{ inci: "", display_name: null, pct: 100, is_colorant: false }] };
  $("#reg-progress").textContent = `${regDone + 1} / ${regTotal}`;
  $("#reg-name").value = item.name; $("#reg-maker").value = ""; $("#reg-note").value = "";
  renderRegComponents();
  setTimeout(() => $("#reg-comp-table tbody tr input")?.focus(), 0);
}
function finishRegister() {
  if (regDialog.open) { if (typeof regDialog.close === "function") regDialog.close(); else regDialog.removeAttribute("open"); }
  if (regDone) applyPasted(lastPasteText, { offerRegister: false });
}
$("#reg-comp-add-btn").addEventListener("click", () => addComponentRow(regEdit.components, renderRegComponents, "#reg-comp-table"));
$("#reg-save-btn").addEventListener("click", () => {
  const fb = $("#reg-feedback"); fb.replaceChildren();
  try {
    const saved = store.save({ name: $("#reg-name").value, maker: $("#reg-maker").value, note: $("#reg-note").value, components: regEdit.components });
    ingredients.absorb(saved.components);
    regDone++; regQueue.shift();
    renderMaterialList(); renderMaterialDatalist();
    nextRegItem();
  } catch (e) { fb.append(alertBox(e.message, "danger")); }
});
$("#reg-skip-btn").addEventListener("click", () => { regQueue.shift(); nextRegItem(); });
$("#reg-close-btn").addEventListener("click", () => { regQueue = []; finishRegister(); });
regDialog.addEventListener("cancel", (e) => { e.preventDefault(); regQueue = []; finishRegister(); });

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
  // ── 訴求点の候補 ──
  {
    const infoMap = ingredients.infoMap();
    const info = (n) => infoMap.get(normKey(n)) || null;
    const noi = naturalOriginIndex(res.entries, info);
    const ic = ingredientClaims(res.entries, info);
    const fmtIdx = (r) => r.low == null ? "-" : (r.coverage >= 99.9 ? `${r.high.toFixed(1)}%` : `${r.low.toFixed(1)}〜${r.high.toFixed(1)}%`);
    const okClaims = freeClaims.length ? checkFreeClaims(res.inciOrder, freeClaims, { colorants }).filter((r) => r.status === "ok").map((r) => r.label) : [];
    const idxText = `自然由来指数 ${fmtIdx(noi.withWater)}（水を含む）/ ${fmtIdx(noi.withoutWater)}（水を除く）`;
    const lines = [
      ...ic.purposeLines.map((l) => l.text),
      ...ic.originLines.map((l) => l.text),
      idxText,
      okClaims.length ? okClaims.map((x) => x.replace(/\s*\(.*\)$/, "")).join("・") : null,
    ].filter(Boolean);
    lastFacts = {
      jpText: res.asText(), inciText: res.asInciText(),
      // 配合% と原料の商品名は機密なので渡さない (成分名・目的・由来のみ)
      entries: res.entries.map((e) => { const i = info(e.inciName); return { name: e.displayName || e.inciName, purpose: i?.purpose || "", origin: i?.origin || "" }; }),
      candidates: [...ic.purposeLines.map((l) => l.text), ...ic.originLines.map((l) => l.text)],
      naturalIndex: idxText.replace(/^自然由来指数 /, ""),
      freeClaims: okClaims.map((x) => x.replace(/\s*\(.*\)$/, "")),
    };
    const row = (k, v) => el("tr", {}, el("td", { class: "small", style: "white-space:nowrap" }, k), el("td", {}, v));
    out.append(el("details", { class: "claims", open: "" },
      el("summary", {}, el("b", {}, "訴求点の候補"), el("span", { class: "muted small" }, " 成分辞書の配合目的・由来・天然由来率から")),
      el("table", { class: "grid" }, el("tbody", {},
        ...ic.purposeLines.map((l) => row(l.purpose, l.names.join("・"))),
        ...ic.originLines.map((l) => row(l.origin, `${l.names.length} 種：${l.names.join("・")}`)),
        row("自然由来指数", el("span", {}, `水を含む ${fmtIdx(noi.withWater)}　水を除く ${fmtIdx(noi.withoutWater)}`,
          noi.withWater.coverage < 99.9 ? el("div", { class: "muted small" }, `天然由来率が未登録の成分が ${(100 - noi.withWater.coverage).toFixed(1)}% 分あります (${noi.withWater.missing.join("、")})。幅は未登録分を 0 と 100 で置いた場合です。`) : null)),
        row("フリー表示", okClaims.length ? okClaims.map((x) => x.replace(/\s*\(.*\)$/, "")).join("・") : el("span", { class: "muted" }, "(該当なし)")))),
      ic.otherLines.length ? el("p", { class: "muted small" }, `訴求にしない目的: ${ic.otherLines.join("、")}`) : null,
      ic.unknown.length ? el("p", { class: "muted small" }, `配合目的・由来が未登録: ${ic.unknown.join("、")}（成分登録タブで登録すると候補に入ります）`) : null,
      ...copyBlock("候補テキスト", lines.join("\n"), "claims-text"),
      el("p", { class: "muted small" }, "候補は成分表と成分辞書の登録内容だけから機械的に作ったものです。効能効果の表現範囲 (薬機法)・優良誤認 (景品表示法)・各社基準への適合は利用者が判断してください。")));
  }
  out.append(renderCopySection());
  if (freeClaims.length) {
    const results = checkFreeClaims(res.inciOrder, freeClaims, { colorants });
    const icon = { ok: "✓", ng: "✗", caution: "△" }, cls = { ok: "ok", ng: "bad", caution: "warn" };
    const nOk = results.filter((r) => r.status === "ok").length;
    out.append(el("details", { class: "claims", open: "" },
      el("summary", {}, el("b", {}, "フリー表示チェック"), el("span", { class: "muted small" }, ` 表示できる根拠あり ${nOk} / ${results.length}`)),
      el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, el("th", {}, "表示"), el("th", {}, "判定"), el("th", {}, "該当成分"))),
        el("tbody", {}, results.map((r) => el("tr", {},
          el("td", { title: r.description }, r.label),
          el("td", {}, el("span", { class: `badge ${cls[r.status]}` }, `${icon[r.status]} ${r.status === "ok" ? "該当なし" : r.status === "ng" ? "該当あり" : "要確認"}`)),
          el("td", { class: "small" }, [...r.ng.map((x) => `✗ ${x}`), ...r.caution.map((x) => `△ ${x}`)].join(" / ")))))),
      el("p", { class: "muted small" }, "✓ は本ルール上の該当成分が無いという意味で、表示の可否は各社基準・公正競争規約・景品表示法の観点で別途判断してください。△ は定義や用途によって該当しうる成分 (防腐補助剤、精油、酸化チタン等)。行にマウスを乗せると定義が出ます。")));
  }
  out.append(...copyBlock("表示名称 (日本語)", res.asText(), "jp-text"));
  out.append(...copyBlock("INCI (英語)", res.asInciText(), "inci-text"));
  out.append(el("ul", { class: "notes" }, res.notes.map((n) => el("li", {}, n))));
  const pcText = o.productClass || "指定なし (最も緩い上限)";
  out.append(el("p", { class: "muted small" },
    `規制照会: 剤型 ${pcText} / 地域 ${o.jurisdictions.length ? o.jurisdictions.join(", ") : "全地域 (最緩)"}。${resolved.notes.join(" ")}`));
  out.append(el("p", { class: "disclaimer small" }, "免責事項: ", DISCLAIMER_TEXT, " ",
    el("a", { href: "#disclaimer", onclick: () => $('.tab[data-tab="help"]').click() }, "詳細")));
}

// ═══════════════════════ 訴求文の LLM 生成 (プロンプトを持って手持ちのチャットへ) ═══════════════════════
let lastFacts = null;
const KEY_COPYOPTS = "cosme-label:copy-opts";
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let copyOpts = (() => { try { return JSON.parse(lsGet(KEY_COPYOPTS) || "{}"); } catch { return {}; } })();

function renderCopySection() {
  const saveOpts = () => lsSet(KEY_COPYOPTS, JSON.stringify(copyOpts));
  const field = (key, label, placeholder) => el("label", { class: "grow" }, label,
    el("input", { value: copyOpts[key] || "", placeholder, onchange: (e) => { copyOpts[key] = e.target.value; saveOpts(); refreshLinks(); } }));
  const modeSel = el("select", { onchange: (e) => { copyOpts.mode = e.target.value; saveOpts(); refreshLinks(); } },
    ...[["cosmetic", "化粧品 (効能 56 項目に収める)"], ["quasi_drug", "医薬部外品"], ["free", "制約なし (事実は守る)"]].map(([v, t]) =>
      el("option", { value: v, ...(v === (copyOpts.mode || "cosmetic") ? { selected: "" } : {}) }, t)));
  const opts = () => ({ ...copyOpts, mode: copyOpts.mode || "cosmetic" });
  const fullPrompt = () => promptAsText(buildClaimPrompt(lastFacts, opts()));
  const shortPrompt = () => promptAsText(buildClaimPrompt(lastFacts, { ...opts(), compact: true }));
  const outBox = el("div");
  const copyBtn = el("button", { class: "primary", onclick: async () => {
    const t = fullPrompt();
    try { await navigator.clipboard.writeText(t); copyBtn.textContent = "コピーしました。チャットに貼ってください"; }
    catch { outBox.replaceChildren(el("pre", { class: "copy" }, t)); copyBtn.textContent = "下に表示しました"; }
    setTimeout(() => { copyBtn.textContent = "プロンプトをコピー"; }, 2500);
  } }, "プロンプトをコピー");
  const linkBox = el("span", { class: "row gap wrap", style: "margin:0" });
  const refreshLinks = () => {
    const linkStyle = "text-decoration:none; padding:6px 12px; border:1px solid #b8c2cc; border-radius:6px";
    linkBox.replaceChildren(...chatLinks(shortPrompt()).map((l) => {
      if (l.tooLong) return el("button", { class: "ghost", disabled: "", title: "プロンプトが長すぎて URL に載りません。コピーを使ってください" }, l.label);
      if (l.copyFirst) {
        // 完全版をクリップボードへ → 新しいタブで開く → 貼り付けてもらう
        return el("a", { class: "ghost", role: "button", href: l.href, target: "_blank", rel: "noopener", style: linkStyle,
          title: "クリックでプロンプトをコピーし、Gemini を開きます。入力欄に貼り付けてください",
          onclick: () => { try { navigator.clipboard.writeText(fullPrompt()); status.textContent = "プロンプトをコピーしました。Gemini の入力欄に貼り付けてください"; } catch { status.textContent = "コピーできませんでした。「プロンプトをコピー」を使ってください"; } } }, l.label);
      }
      return el("a", { class: "ghost", role: "button", href: l.href, target: "_blank", rel: "noopener", style: linkStyle }, l.label);
    }));
  };
  refreshLinks();
  const status = el("span", { class: "muted small" });
  const showBtn = el("button", { class: "ghost", onclick: () => { outBox.replaceChildren(el("pre", { class: "copy" }, fullPrompt())); } }, "プロンプトを表示");
  return el("details", { class: "claims", open: "" },
    el("summary", {}, el("b", {}, "訴求文を LLM で作る"), el("span", { class: "muted small" }, " 成分表と候補を「事実」として渡し、手持ちのチャットで文案の下書きを作る")),
    el("div", { class: "row gap wrap" }, field("productName", "製品名 ", "例: モイストシャンプー"), field("productType", "剤型・カテゴリ ", "例: シャンプー / 化粧水 / クリーム")),
    el("div", { class: "row gap wrap" }, field("target", "ターゲット ", "例: 30 代女性、乾燥が気になる人"), field("tone", "トーン ", "例: 誠実で分かりやすい / 上質感")),
    el("div", { class: "row gap wrap" }, el("label", { class: "grow" }, "補足 (自由記述) ", el("input", { value: copyOpts.extra || "", placeholder: "例: 詰め替え対応、ノンシリコンを前面に", onchange: (e) => { copyOpts.extra = e.target.value; saveOpts(); refreshLinks(); } })),
      el("label", {}, "表現の制約 ", modeSel)),
    el("div", { class: "row gap wrap" }, copyBtn, linkBox, showBtn, status),
    el("p", { class: "muted small" }, el("b", {}, "機密の扱い: "), "プロンプトに配合% と原料の商品名は含めません。渡すのは全成分表示 (公開情報)、成分の配合目的・由来、候補文、自然由来指数だけです。それでも外部サービスに送る内容なので、送る前に「プロンプトを表示」で確認してください。"),
    el("p", { class: "muted small" }, "「〜で開く」はプロンプト入りで新しいチャットを開きます (短縮版。効能 56 項目の全文と成分ごとの詳細は省き、コピー版には含みます)。生成文は下書きです。効能効果の範囲・優良誤認・各社基準への適合は必ず人が確認してください。"),
    outBox);
}

// ═══════════════════════ 原料登録 ═══════════════════════
let edit = { id: null, components: [] };
let selectedId = null;

function renderMaterialList() {
  $("#mat-empty").hidden = store.count() > 0;
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

/** 構成成分の編集表を描く (原料登録タブと貼り付け時の登録ウィンドウで共用)。 */
function renderComponentTable(tbody, totalBadge, comps, rerender) {
  tbody.replaceChildren();
  comps.forEach((c, i) => {
    tbody.append(el("tr", {},
      el("td", {}, el("input", { value: c.inci, placeholder: "INCI 名", list: "inci-list", oninput: (e) => renderInciDatalist(e.target.value), onchange: (e) => {
        c.inci = e.target.value.trim();
        const known = ingredients.get(c.inci) || ingredients.getByDisplayName(c.inci);
        if (known) { c.inci = known.inci; if (!c.display_name && known.display_name) c.display_name = known.display_name; if (known.is_colorant) c.is_colorant = true; }
        if (isCiNumber(c.inci)) c.is_colorant = true;
        rerender();
      } })),
      el("td", {}, el("input", { value: c.display_name || "", placeholder: "表示名称 (任意)", onchange: (e) => { c.display_name = e.target.value.trim() || null; } })),
      el("td", { class: "num" }, el("input", { type: "number", min: 0, max: 100, step: 0.01, value: c.pct ?? "", onchange: (e) => { c.pct = parseFloat(e.target.value); updateTotalBadge(totalBadge, comps); } })),
      el("td", {}, el("input", { type: "checkbox", ...(c.is_colorant ? { checked: "" } : {}), onchange: (e) => { c.is_colorant = e.target.checked; } })),
      el("td", {}, el("button", { type: "button", class: "ghost danger", onclick: () => { comps.splice(i, 1); rerender(); } }, "✕")),
    ));
  });
  updateTotalBadge(totalBadge, comps);
}
function updateTotalBadge(b, comps) {
  if (!comps.length) { b.textContent = "成分なし"; b.className = "badge"; return; }
  const t = comps.reduce((s, c) => s + (Number(c.pct) || 0), 0); const d = t - 100;
  b.textContent = `構成計: ${t.toFixed(2)}%${Math.abs(d) > 0.05 ? ` (${d >= 0 ? "+" : ""}${d.toFixed(2)}%)` : ""}`;
  b.className = "badge " + (Math.abs(d) <= 0.05 ? "ok" : d > 0 ? "bad" : "warn");
}
function addComponentRow(comps, rerender, tableSel) {
  comps.push({ inci: "", display_name: null, pct: comps.length ? null : 100, is_colorant: false });
  rerender(); $(`${tableSel} tbody tr:last-child input`).focus();
}
function renderComponents() { renderComponentTable($("#comp-table tbody"), $("#comp-total"), edit.components, renderComponents); }
$("#comp-add-btn").addEventListener("click", () => addComponentRow(edit.components, renderComponents, "#comp-table"));

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
  const fbSel = input.id.startsWith("ing-") ? "#ing-list-feedback" : input.id.startsWith("rule-") ? "#rule-list-feedback" : "#mat-list-feedback";
  rd.onload = () => { try { cb(rd.result); } catch (e) { $(fbSel).replaceChildren(alertBox(`取込失敗: ${e.message}`, "danger")); } input.value = ""; };
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

const PURPOSES = ["基剤", "保湿剤", "保湿成分", "整肌成分", "エモリエント剤", "洗浄剤", "乳化剤", "可溶化剤", "乳化安定剤", "増粘剤", "皮膜形成剤", "コンディショニング剤",
  "防腐剤", "酸化防止剤", "キレート剤", "pH調整剤", "紫外線防御剤", "着色剤", "パール剤", "感触調整剤", "溶剤", "香料", "スクラブ剤", "清涼剤", "収れん剤", "美白成分 (医薬部外品)", "有効成分 (医薬部外品)"];
$("#purpose-list").replaceChildren(...PURPOSES.map((x) => el("option", { value: x })));
$("#ing-origin").append(...ORIGINS.map((x) => el("option", { value: x }, x)));

function renderInciDatalist(q = "") {
  // 1 万件超の辞書でも重くならないよう、入力中の文字列に合う 50 件だけを候補にする
  $("#inci-list").replaceChildren(...ingredients.search(q, 50).map((x) => el("option", { value: x.inci }, x.display_name || "")));
}
function renderIngredientList() {
  $("#ing-empty").hidden = ingredients.count() > 0;
  const q = $("#ing-search").value.trim();
  const all = q ? ingredients.search(q, 100000) : ingredients.listAll();
  const LIMIT = 200;
  const list = all.slice(0, LIMIT);
  const tb = $("#ing-table tbody"); tb.replaceChildren();
  if (all.length > LIMIT) tb.append(el("tr", {}, el("td", { colspan: 4, class: "small muted" }, `${all.length} 件中 ${LIMIT} 件を表示。検索で絞り込んでください。`)));
  for (const x of list) {
    tb.append(el("tr", { class: ingEdit && IngredientStore.key(ingEdit) === IngredientStore.key(x.inci) ? "selected" : "", onclick: () => loadIngredient(x) },
      el("td", {}, x.inci), el("td", {}, x.display_name || el("span", { class: "muted" }, "(未設定)")),
      el("td", { class: "small" }, x.purpose || ""), el("td", { class: "small" }, x.origin || ""),
      el("td", { class: "num small" }, x.natural_index ?? ""), el("td", {}, x.is_colorant ? "✓" : "")));
  }
  $("#ing-count").textContent = ingredients.count();
}
$("#ing-search").addEventListener("input", renderIngredientList);
function loadIngredient(x) {
  ingEdit = x.inci;
  $("#ing-inci").value = x.inci; $("#ing-display").value = x.display_name || "";
  $("#ing-colorant").checked = !!x.is_colorant; $("#ing-note").value = x.note || "";
  $("#ing-purpose").value = x.purpose || ""; $("#ing-origin").value = x.origin || ""; $("#ing-natural").value = x.natural_index ?? "";
  $("#ing-edit-title").textContent = "成分の編集"; $("#ing-edit-feedback").replaceChildren();
  renderIngredientList();
}
function newIngredient() {
  ingEdit = null;
  ["#ing-inci", "#ing-display", "#ing-note", "#ing-purpose", "#ing-natural"].forEach((id) => { $(id).value = ""; });
  $("#ing-origin").value = ""; $("#ing-colorant").checked = false; $("#ing-edit-title").textContent = "成分の登録"; $("#ing-edit-feedback").replaceChildren();
  renderIngredientList();
}
$("#ing-new-btn").addEventListener("click", newIngredient);
$("#ing-save-btn").addEventListener("click", () => {
  const fb = $("#ing-edit-feedback"); fb.replaceChildren();
  try {
    const inci = $("#ing-inci").value.trim();
    if (ingEdit && IngredientStore.key(ingEdit) !== IngredientStore.key(inci)) ingredients.delete(ingEdit); // INCI 名の変更
    const saved = ingredients.save({ inci, display_name: $("#ing-display").value, is_colorant: $("#ing-colorant").checked || isCiNumber(inci), note: $("#ing-note").value,
      purpose: $("#ing-purpose").value, origin: $("#ing-origin").value, natural_index: $("#ing-natural").value });
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
async function loadStarterIngredients({ silent = false } = {}) {
  const t = await (await fetch("data/starter_ingredients.csv")).text();
  const { saved, errors } = ingredients.importCsv(t);
  renderIngredientList(); renderInciDatalist(); renderLabel();
  if (!silent) $("#ing-list-feedback").replaceChildren(alertBox(`基本成分 ${saved.length} 件を読み込みました${errors.length ? ` (${errors.length} 件失敗)` : ""}`, errors.length ? "warn" : "success"));
  return saved.length;
}
$("#ing-starter-btn").addEventListener("click", () => loadStarterIngredients());
$("#ing-starter-btn-empty").addEventListener("click", () => loadStarterIngredients());
// 初回アクセス (成分マスタが空で、まだ自動読込していない) は基本成分を自動で入れる
(async () => {
  const FLAG = "cosme-label:starter-loaded:v1";
  let done = false; try { done = !!localStorage.getItem(FLAG); } catch {}
  if (!done && ingredients.count() === 0) {
    try { await loadStarterIngredients({ silent: true }); localStorage.setItem(FLAG, "1"); } catch {}
  }
})();
$("#ing-sample-btn").addEventListener("click", async () => {
  const t = await (await fetch("data/sample_materials.csv")).text();
  reportImport(store.importCsv(t), "サンプル原料"); renderIngredientList();
  $("#ing-list-feedback").replaceChildren(alertBox(`サンプル原料 ${store.count()} 件と、その構成成分 ${ingredients.count()} 件を読み込みました`, "success"));
});
const importIngredientCsv = (t) => {
  const recs = parseCsvRecords(t);
  if (!recs.length || IngredientStore.normalizeRow(recs[0]).inci === undefined) throw new Error("INCI 名の列が見つかりません (inci_name / INCI名 など。任意: display_name / 表示名称, is_colorant, note)");
  const { saved, errors } = ingredients.importCsv(t);
  const fb = $("#ing-list-feedback"); fb.replaceChildren();
  fb.append(alertBox(`CSV 取込: ${saved.length} 成分`, errors.length ? "warn" : "success"));
  if (errors.length) fb.append(el("div", { class: "alert danger" }, el("ul", {}, errors.map((x) => el("li", {}, x)))));
  newIngredient(); renderInciDatalist(); renderLabel();
};
$("#ing-import-csv").addEventListener("change", (e) => readFile(e.target, importIngredientCsv));
$("#ing-import-csv-empty").addEventListener("change", (e) => readFile(e.target, importIngredientCsv));

$("#footer-disclaimer").addEventListener("click", () => $('.tab[data-tab="help"]').click());

// ═══════════════════════ フリー表示ルール ═══════════════════════
let ruleEdit = null; // { id, builtin, label, description, ng:[term], caution:[term], exclude:[term] }

function ruleRows() {
  const base = (claimData.claims || []).map((c) => ({ id: c.id, label: c.label, builtin: true }));
  const custom = ruleStore.rules.custom.map((c) => ({ id: c.id, label: c.label, builtin: false }));
  return [...base, ...custom];
}
function renderRuleList() {
  const tb = $("#rule-table tbody"); tb.replaceChildren();
  for (const r of ruleRows()) {
    const o = r.builtin ? ruleStore.override(r.id) : ruleStore.custom(r.id) || {};
    const nTerms = (o.ng || []).length + (o.caution || []).length + (o.exclude || []).length;
    const chk = el("input", { type: "checkbox", ...(ruleStore.isDisabled(r.id) ? {} : { checked: "" }), onclick: (e) => { e.stopPropagation(); ruleStore.setEnabled(r.id, e.target.checked); rebuildClaims(); renderLabel(); renderRuleList(); } });
    tb.append(el("tr", { class: ruleEdit && ruleEdit.id === r.id ? "selected" : "", onclick: () => loadRule(r.id, r.builtin) },
      el("td", {}, chk), el("td", {}, r.label, r.builtin ? "" : el("span", { class: "sub" }, "自作")),
      el("td", { class: "small" }, nTerms ? `追加 ${nTerms} 件` : "")));
  }
}
function loadRule(id, builtin) {
  const base = builtin ? claimData.claims.find((c) => c.id === id) : null;
  const src = builtin ? ruleStore.override(id) : (ruleStore.custom(id) || {});
  ruleEdit = { id, builtin, label: builtin ? base.label : src.label || "", description: builtin ? base.description : src.description || "",
    ng: (src.ng || []).map((t) => ({ ...t })), caution: (src.caution || []).map((t) => ({ ...t })), exclude: (src.exclude || []).map((t) => ({ ...t })) };
  $("#rule-edit-title").textContent = ruleEdit.label || "新しい表示";
  $("#rule-edit-body").hidden = false;
  $("#rule-label").value = ruleEdit.label; $("#rule-label").disabled = builtin;
  $("#rule-desc").value = ruleEdit.description; $("#rule-desc").disabled = builtin;
  $("#rule-builtin").hidden = !builtin;
  if (builtin) $("#rule-builtin-pre").textContent = [`該当: ${base.ng.join("  |  ") || "-"}`, `要確認: ${base.caution.join("  |  ") || "-"}`, `除外: ${base.exclude.join("  |  ") || "-"}`].join("\n");
  $("#rule-reset-btn").hidden = !builtin; $("#rule-delete-btn").hidden = builtin;
  $("#rule-edit-feedback").replaceChildren();
  renderRuleTerms(); renderRuleList();
}
function renderRuleTerms() {
  for (const table of $$(".rule-terms")) {
    const kind = table.dataset.kind; const tb = table.querySelector("tbody"); tb.replaceChildren();
    ruleEdit[kind].forEach((t, i) => tb.append(el("tr", {},
      el("td", {}, el("input", { value: t.text || "", placeholder: "例: Polysorbate 80", list: "inci-list", oninput: (e) => renderInciDatalist(e.target.value), onchange: (e) => { t.text = e.target.value.trim(); } })),
      el("td", {}, el("select", { onchange: (e) => { t.mode = e.target.value; } },
        el("option", { value: "exact", ...(t.mode !== "contains" ? { selected: "" } : {}) }, "完全一致"),
        el("option", { value: "contains", ...(t.mode === "contains" ? { selected: "" } : {}) }, "含む"))),
      el("td", {}, el("button", { type: "button", class: "ghost danger", onclick: () => { ruleEdit[kind].splice(i, 1); renderRuleTerms(); } }, "✕")))));
  }
}
$$(".rule-term-add").forEach((b) => b.addEventListener("click", () => { ruleEdit[b.dataset.kind].push({ text: "", mode: "exact" }); renderRuleTerms(); }));
$("#rule-new-btn").addEventListener("click", () => { ruleEdit = null; loadRule(null, false); });
$("#rule-save-btn").addEventListener("click", () => {
  const fb = $("#rule-edit-feedback"); fb.replaceChildren();
  const clean = (arr) => arr.filter((t) => (t.text || "").trim());
  try {
    if (ruleEdit.builtin) ruleStore.setOverride(ruleEdit.id, { ng: clean(ruleEdit.ng), caution: clean(ruleEdit.caution), exclude: clean(ruleEdit.exclude) });
    else {
      const saved = ruleStore.saveCustom({ id: ruleEdit.id, label: $("#rule-label").value, description: $("#rule-desc").value, ng: clean(ruleEdit.ng), caution: clean(ruleEdit.caution), exclude: clean(ruleEdit.exclude) });
      ruleEdit.id = saved.id;
    }
    rebuildClaims(); renderLabel(); loadRule(ruleEdit.id, ruleEdit.builtin);
    fb.append(alertBox("保存しました", "success"));
  } catch (e) { fb.append(alertBox(e.message, "danger")); }
});
$("#rule-reset-btn").addEventListener("click", () => { if (!ruleEdit?.builtin) return; ruleStore.resetOverride(ruleEdit.id); rebuildClaims(); renderLabel(); loadRule(ruleEdit.id, true); });
$("#rule-delete-btn").addEventListener("click", () => {
  if (!ruleEdit || ruleEdit.builtin || !ruleEdit.id) return;
  if (!confirm(`「${ruleEdit.label}」を削除しますか?`)) return;
  ruleStore.deleteCustom(ruleEdit.id); ruleEdit = null; $("#rule-edit-body").hidden = true; $("#rule-edit-title").textContent = "表示を選んでください";
  rebuildClaims(); renderLabel(); renderRuleList();
});
$("#rule-reset-all").addEventListener("click", () => {
  if (!confirm("フリー表示ルールの自社設定をすべて消して初期値に戻しますか?")) return;
  ruleStore.resetAll(); ruleEdit = null; $("#rule-edit-body").hidden = true; rebuildClaims(); renderLabel(); renderRuleList();
  $("#rule-list-feedback").replaceChildren(alertBox("初期値に戻しました", "success"));
});
$("#rule-export").addEventListener("click", () => download("claim_rules.json", ruleStore.exportJson(), "application/json"));
$("#rule-import").addEventListener("change", (e) => readFile(e.target, (t) => {
  ruleStore.importJson(t); rebuildClaims(); renderLabel(); renderRuleList();
  $("#rule-list-feedback").replaceChildren(alertBox("設定を読み込みました", "success"));
}));

// ── 初期描画 ────────────────────────────────────────────────────────────────
renderMaterialList(); renderComponents(); renderMaterialDatalist(); renderInciDatalist(); renderIngredientList(); renderFormula();
