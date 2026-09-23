#!/usr/bin/env node
// 成分表ジェネレーターのロジックを MCP (stdio) の道具として公開する。
// 画面版と同じ js/label.js を使うので判定は同一。すべてローカルで動き、外部には何も送らない
// (配合% を渡しても手元の計算にしか使わない)。辞書データ (JCIA 等) は含まない。
//
// 使い方 (Claude Code の例):  claude mcp add cosme-label -- node /path/to/cosme-label/mcp/server.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  buildIngredientLabel, parseFormulaText, indexRegulatoryRows, resolveRegulatoryLimits, checkRegulatory, findingText,
  compileFreeClaims, checkFreeClaims, applyClaimRules, naturalOriginIndex, ingredientClaims, isCiNumber, LabelError,
} from "../js/label.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const regTable = indexRegulatoryRows(JSON.parse(readFileSync(join(root, "data/regulatory_limits_inci.json"), "utf8")));
const claimData = JSON.parse(readFileSync(join(root, "data/free_claims.json"), "utf8"));

const server = new McpServer({ name: "cosme-label", version: "0.1.0" });
const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });

const materialsSchema = z.record(z.string(), z.record(z.string(), z.number())).describe("{原料名: {INCI: 原料中%}}");
const formulaSchema = z.record(z.string(), z.number()).describe("{原料名: 配合%}");
const optionsSchema = z.object({
  threshold_pct: z.number().min(0).default(1).describe("順不同とする濃度閾値 (%)"),
  display_names: z.record(z.string(), z.string()).optional().describe("{INCI: 表示名称}"),
  colorants: z.array(z.string()).optional().describe("着色剤として末尾に送る INCI"),
  normalize: z.boolean().default(false).describe("合計が 100 でなければ正規化"),
}).default({});

function labelOf(formula, materials, options = {}) {
  const colorants = new Set([...(options.colorants || [])]);
  for (const comp of Object.values(materials)) for (const inci of Object.keys(comp)) if (isCiNumber(inci)) colorants.add(inci);
  return buildIngredientLabel(formula, materials, {
    thresholdPct: options.threshold_pct ?? 1, displayNames: options.display_names ?? null,
    colorants: colorants.size ? colorants : null, normalize: !!options.normalize,
  });
}
const serializeLabel = (res) => ({
  entries: res.entries.map((e) => ({ position: e.position, inci: e.inciName, display_name: e.displayName, pct: e.pct, sources: e.sources, unordered_ok: e.unorderedOk, is_colorant: e.isColorant })),
  jp_text: res.asText(), inci_text: res.asInciText(), inci_order: res.inciOrder,
  total_pct: res.totalPct, labeled_pct: res.labeledPct, warnings: res.warnings, notes: res.notes,
});

server.registerTool("build_label", {
  title: "全成分表示を生成",
  description: "処方 {原料名: 配合%} と原料構成 {原料名: {INCI: 原料中%}} から、INCI ごとに合算して全成分表示の記載順 (降順 / 閾値以下は順不同帯 / 着色剤は末尾) を返す。",
  inputSchema: { formula: formulaSchema, materials: materialsSchema, options: optionsSchema },
}, async ({ formula, materials, options }) => {
  try { return text(serializeLabel(labelOf(formula, materials, options))); } catch (e) { return fail(e); }
});

server.registerTool("parse_formula_text", {
  title: "処方テキストを解析",
  description: "「原料名 配合%」を 1 行 1 原料で書いたテキスト (タブ/カンマ/コロン区切り、% 任意、逆順・全角可) を [{name, pct}] にする。pct が読めない行は null。",
  inputSchema: { text: z.string() },
}, async ({ text: t }) => text(parseFormulaText(t).map(([name, pct]) => ({ name, pct }))));

server.registerTool("check_regulatory", {
  title: "規制上限と突き合わせ",
  description: "INCI 名と配合% ({INCI: %}) を、EU 1223/2009 Annex・化粧品基準 (告示331号)・KFDA・21 CFR 由来の配合上限/禁止 (595 行) と突き合わせる。剤型・地域未指定時は最も緩い上限 (真値を切り落とさない側)。規制は改正されるので最終判断は原文で。",
  inputSchema: {
    inci_pct: z.record(z.string(), z.number()).describe("{INCI: 処方中の%}"),
    product_class: z.enum(["rinse_off", "leave_on"]).optional().describe("剤型 (省略で最緩)"),
    jurisdictions: z.array(z.enum(["JP", "EU", "US", "KR"])).optional().describe("対象地域 (省略で全地域の最緩)"),
  },
}, async ({ inci_pct, product_class, jurisdictions }) => {
  try {
    const names = Object.keys(inci_pct);
    const resolved = resolveRegulatoryLimits(regTable, names, { productClass: product_class ?? null, jurisdictions: jurisdictions ?? null });
    const label = { entries: names.map((n) => ({ inciName: n, pct: inci_pct[n] })) };
    const findings = checkRegulatory(label, resolved);
    return text({ limits: resolved, findings: findings.map((f) => ({ ...f, text: findingText(f) })), disclaimer: "情報提供のみ。規制は改正されるため最新原文と専門家の確認を。" });
  } catch (e) { return fail(e); }
});

server.registerTool("check_free_claims", {
  title: "フリー表示の根拠チェック",
  description: "INCI 名の一覧に対し、パラベン/防腐剤/旧表示指定成分/無香料/無着色/タール色素/アルコール/鉱物油/シリコン/サルフェート/PEG/EDTA/UV吸収剤/UV散乱剤/グルテン/尿素フリーの 17 表示を判定 (ok=該当なし / ng=該当あり / caution=要確認)。rules で自社ルール (disabled/overrides/custom) を重ねられる。",
  inputSchema: {
    inci_names: z.array(z.string()),
    colorants: z.array(z.string()).optional().describe("原料側で着色剤にした INCI"),
    rules: z.object({ disabled: z.array(z.string()).optional(), overrides: z.record(z.string(), z.any()).optional(), custom: z.array(z.any()).optional() }).optional(),
  },
}, async ({ inci_names, colorants, rules }) => {
  try {
    const claims = compileFreeClaims(rules ? applyClaimRules(claimData, rules) : claimData);
    return text(checkFreeClaims(inci_names, claims, { colorants: colorants ?? null }));
  } catch (e) { return fail(e); }
});

server.registerTool("natural_origin_index", {
  title: "自然由来指数 (ISO 16128 の考え方)",
  description: "成分表 [{inci, pct}] と成分ごとの天然由来率 {INCI: 0-100} から、処方の自然由来指数を水含む/除くで返す。未登録成分は 0 と 100 で置いた幅で返す。",
  inputSchema: {
    entries: z.array(z.object({ inci: z.string(), pct: z.number() })),
    natural_index: z.record(z.string(), z.number().min(0).max(100)).describe("{INCI: 天然由来率}"),
  },
}, async ({ entries, natural_index }) => {
  const norm = (n) => String(n).normalize("NFKC").trim().toLowerCase().replace(/[\s\-‐‑–—]+/g, " ");
  const map = new Map(Object.entries(natural_index).map(([k, v]) => [norm(k), v]));
  const info = (n) => (map.has(norm(n)) ? { natural_index: map.get(norm(n)) } : null);
  return text(naturalOriginIndex(entries.map((e) => ({ inciName: e.inci, pct: e.pct })), info));
});

server.registerTool("claim_candidates", {
  title: "訴求点の候補",
  description: "成分表の INCI と成分辞書 {INCI: {display_name, purpose, origin}} から「目的：成分」「植物由来成分 N 種」型の候補文を作る (訴求にならない目的・由来は補足に)。",
  inputSchema: {
    inci_names: z.array(z.string()),
    dictionary: z.record(z.string(), z.object({ display_name: z.string().optional(), purpose: z.string().optional(), origin: z.string().optional() })),
  },
}, async ({ inci_names, dictionary }) => {
  const norm = (n) => String(n).normalize("NFKC").trim().toLowerCase().replace(/[\s\-‐‑–—]+/g, " ");
  const map = new Map(Object.entries(dictionary).map(([k, v]) => [norm(k), v]));
  const entries = inci_names.map((n) => ({ inciName: n, displayName: map.get(norm(n))?.display_name || null }));
  const info = (n) => map.get(norm(n)) || null;
  return text(ingredientClaims(entries, info));
});

const transport = new StdioServerTransport();
await server.connect(transport);
