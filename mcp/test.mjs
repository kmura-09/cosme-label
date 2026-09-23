// MCP サーバーを子プロセスで起動し、道具の一覧と主要な呼び出しを検証する。  node mcp/test.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "cosme-label-test", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(here, "server.mjs")] }));

const parse = (r) => JSON.parse(r.content[0].text);
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["build_label", "check_free_claims", "check_regulatory", "claim_candidates", "natural_origin_index", "parse_formula_text"]);

const materials = { "精製水": { Water: 100 }, "SLES-27": { "Sodium Laureth Sulfate": 27, Water: 73 }, "フェノキシ": { Phenoxyethanol: 100 }, "酸化鉄": { "CI 77491": 100 } };
const label = parse(await client.callTool({ name: "build_label", arguments: { formula: { "精製水": 55, "SLES-27": 40, "フェノキシ": 2, "酸化鉄": 3 }, materials } }));
assert.deepEqual(label.inci_order, ["Water", "Sodium Laureth Sulfate", "Phenoxyethanol", "CI 77491"]); // CI 番号は自動で末尾
assert.equal(label.entries[0].pct, 84.2);

const parsed = parse(await client.callTool({ name: "parse_formula_text", arguments: { text: "精製水\t55\nSLES-27, 40%" } }));
assert.deepEqual(parsed, [{ name: "精製水", pct: 55 }, { name: "SLES-27", pct: 40 }]);

const reg = parse(await client.callTool({ name: "check_regulatory", arguments: { inci_pct: { Phenoxyethanol: 2, Water: 90 }, jurisdictions: ["JP"] } }));
assert.ok(reg.findings.some((f) => f.inciName === "Phenoxyethanol" && f.exceeded && f.limitPct === 1));

const free = parse(await client.callTool({ name: "check_free_claims", arguments: { inci_names: ["Water", "Methylparaben", "Sodium Laureth Sulfate"] } }));
const by = Object.fromEntries(free.map((r) => [r.id, r]));
assert.equal(by.paraben_free.status, "ng"); assert.equal(by.sulfate_free.status, "ng"); assert.equal(by.silicone_free.status, "ok");
const custom = parse(await client.callTool({ name: "check_free_claims", arguments: { inci_names: ["Methylparaben"], rules: { disabled: ["paraben_free"] } } }));
assert.ok(!custom.some((r) => r.id === "paraben_free"));

const noi = parse(await client.callTool({ name: "natural_origin_index", arguments: { entries: [{ inci: "Water", pct: 90 }, { inci: "Dimethicone", pct: 10 }], natural_index: { Water: 100, Dimethicone: 0 } } }));
assert.deepEqual([noi.withWater.low, noi.withWater.high, noi.withoutWater.high], [90, 90, 0]);

const cands = parse(await client.callTool({ name: "claim_candidates", arguments: { inci_names: ["Water", "Glycerin"], dictionary: { Glycerin: { display_name: "グリセリン", purpose: "保湿剤", origin: "植物由来" }, Water: { display_name: "水", purpose: "基剤", origin: "水" } } } }));
assert.deepEqual(cands.purposeLines.map((l) => l.text), ["保湿剤：グリセリン"]);

const bad = await client.callTool({ name: "build_label", arguments: { formula: { Nope: 100 }, materials } });
assert.ok(bad.isError && bad.content[0].text.includes("未登録"));

await client.close();
console.log("mcp ok: 6 tools, 9 checks passed");
