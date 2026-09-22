// 原料マスタの保存層 (localStorage)。サーバー無しで完結する。
// データはこのブラウザにだけ残る。持ち出しは CSV / JSON 書出で行う。

import { parseCsvRecords, toCsv } from "./csv.js";

const KEY = "cosme-label:materials:v1";
const SUM_TOL = 0.05;

export const CSV_COLUMNS = ["name", "maker", "note", "inci_name", "pct", "display_name", "is_colorant"];

function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

function truthy(v) {
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "y", "はい", "○", "〇", "x", "✓"].includes(String(v).trim().toLowerCase());
}

export function validateComponents(components) {
  const errors = [];
  if (!components.length) return ["成分が 1 つもありません"];
  const seen = new Set();
  for (const c of components) {
    const name = (c.inci || "").trim();
    if (!name) { errors.push("INCI 名が空の成分があります"); continue; }
    const k = name.toLowerCase();
    if (seen.has(k)) errors.push(`INCI が重複しています: ${name}`);
    seen.add(k);
    const pct = Number(c.pct);
    if (!(pct > 0 && pct <= 100)) errors.push(`${name} の % が範囲外です (${c.pct})。0 より大きく 100 以下にしてください`);
  }
  const total = components.reduce((s, c) => s + Number(c.pct || 0), 0);
  if (total > 100 + SUM_TOL) errors.push(`構成比の合計が 100% を超えています (${total.toFixed(2)}%)`);
  return errors;
}

export function totalPct(m) { return m.components.reduce((s, c) => s + Number(c.pct || 0), 0); }
export function isComplete(m) { return Math.abs(totalPct(m) - 100) <= SUM_TOL; }

export class MaterialStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this._items = this._load();
  }

  _load() {
    try {
      const raw = this.storage?.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  _persist() {
    try { this.storage?.setItem(KEY, JSON.stringify(this._items)); } catch (e) {
      throw new Error("保存できませんでした (ブラウザのストレージが使えません): " + e.message);
    }
  }

  listAll() {
    return this._items.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }
  count() { return this._items.length; }
  get(id) { return this._items.find((m) => m.id === id) || null; }
  getByName(name) {
    const k = String(name ?? "").trim().toLowerCase();
    return this._items.find((m) => m.name.toLowerCase() === k) || null;
  }
  search(q, max = 30) {
    const k = String(q ?? "").trim().toLowerCase();
    if (!k) return [];
    return this.listAll().filter((m) =>
      m.name.toLowerCase().includes(k) || (m.maker || "").toLowerCase().includes(k) ||
      m.components.some((c) => c.inci.toLowerCase().includes(k))).slice(0, max);
  }

  /** 新規 or 上書き (id があれば id、無ければ name で既存を探す)。検証エラーは throw。 */
  save(material) {
    const name = (material.name || "").trim();
    if (!name) throw new Error("原料名が空です");
    const components = (material.components || []).map((c) => ({
      inci: (c.inci || "").trim(),
      pct: Number(c.pct),
      display_name: (c.display_name || "").trim() || null,
      is_colorant: !!c.is_colorant,
    }));
    const errors = validateComponents(components);
    if (errors.length) throw new Error(errors.join("; "));

    let target = material.id ? this.get(material.id) : this.getByName(name);
    if (material.id) {
      const clash = this._items.find((m) => m.id !== material.id && m.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new Error(`同名の原料が既に登録されています: ${name}`);
    }
    const t = now();
    if (!target) {
      target = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), created_at: t };
      this._items.push(target);
    }
    Object.assign(target, {
      name, maker: (material.maker || "").trim() || null, note: (material.note || "").trim() || null,
      components, updated_at: t,
    });
    this._persist();
    return target;
  }

  delete(id) {
    const n = this._items.length;
    this._items = this._items.filter((m) => m.id !== id);
    this._persist();
    return this._items.length < n;
  }

  clear() { this._items = []; this._persist(); }

  /** フラット行 (name, inci_name, pct[, maker, note, display_name, is_colorant]) から一括登録。 */
  importRows(rows, { replace = true } = {}) {
    const grouped = new Map();
    for (const r of rows) {
      const name = String(r.name || "").trim();
      if (!name) continue;
      if (!grouped.has(name)) grouped.set(name, { name, maker: r.maker, note: r.note, components: [] });
      grouped.get(name).components.push({
        inci: String(r.inci_name || "").trim(), pct: Number(r.pct || 0),
        display_name: String(r.display_name || "").trim() || null, is_colorant: truthy(r.is_colorant),
      });
    }
    const saved = [], errors = [];
    for (const g of grouped.values()) {
      if (!replace && this.getByName(g.name)) continue;
      try { saved.push(this.save(g)); } catch (e) { errors.push(`${g.name}: ${e.message}`); }
    }
    return { saved, errors };
  }

  importCsv(text, opts) { return this.importRows(parseCsvRecords(text), opts); }

  exportRows() {
    const out = [];
    for (const m of this.listAll()) {
      for (const c of m.components) {
        out.push({ name: m.name, maker: m.maker || "", note: m.note || "", inci_name: c.inci, pct: c.pct,
          display_name: c.display_name || "", is_colorant: c.is_colorant ? 1 : 0 });
      }
    }
    return out;
  }
  exportCsv() { return toCsv(this.exportRows(), CSV_COLUMNS); }

  exportJson() { return JSON.stringify({ schema: "cosme-label/1", exported_at: now(), materials: this._items }, null, 1); }
  importJson(text, { replace = true } = {}) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.materials;
    if (!Array.isArray(list)) throw new Error("JSON の形式が違います (materials 配列がありません)");
    const saved = [], errors = [];
    for (const m of list) {
      if (!replace && this.getByName(m.name)) continue;
      try { saved.push(this.save({ ...m, id: undefined })); } catch (e) { errors.push(`${m.name}: ${e.message}`); }
    }
    return { saved, errors };
  }
}


// ── 成分マスタ (INCI ↔ 表示名称 ↔ 着色剤) ─────────────────────────────────
// ユーザー自身が育てる INCI 辞書。原料登録で同じ INCI の表示名称を入れ直さずに済み、
// 成分表の表示名称の既定値になる (原料側の表示名称が入っていればそちらを優先)。
const IKEY = "cosme-label:ingredients:v1";
export const INGREDIENT_CSV_COLUMNS = ["inci_name", "display_name", "is_colorant", "note"];

export class IngredientStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this._items = this._load();
  }
  _load() {
    try { const raw = this.storage?.getItem(IKEY); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  _persist() {
    try { this.storage?.setItem(IKEY, JSON.stringify(this._items)); } catch (e) {
      throw new Error("保存できませんでした (ブラウザのストレージが使えません): " + e.message);
    }
  }
  static key(inci) { return String(inci ?? "").trim().split(/\s+/).join(" ").toLowerCase(); }
  listAll() { return this._items.slice().sort((a, b) => a.inci.localeCompare(b.inci, "en")); }
  count() { return this._items.length; }
  get(inci) { const k = IngredientStore.key(inci); return this._items.find((x) => IngredientStore.key(x.inci) === k) || null; }
  search(q, max = 50) {
    const k = String(q ?? "").trim().toLowerCase();
    if (!k) return this.listAll().slice(0, max);
    return this.listAll().filter((x) => x.inci.toLowerCase().includes(k) || (x.display_name || "").toLowerCase().includes(k)).slice(0, max);
  }
  /** 登録 / 上書き。display_name が空でも INCI だけ登録できる。 */
  save(item, { overwrite = true } = {}) {
    const inci = String(item.inci || "").trim();
    if (!inci) throw new Error("INCI 名が空です");
    let t = this.get(inci);
    if (t && !overwrite) return t;
    if (!t) { t = { inci }; this._items.push(t); }
    Object.assign(t, {
      inci, display_name: String(item.display_name || "").trim() || null,
      is_colorant: !!item.is_colorant, note: String(item.note || "").trim() || null,
    });
    this._persist();
    return t;
  }
  /** 原料の構成成分から未登録の INCI を取り込む (既存は上書きしない)。 */
  absorb(components) {
    let n = 0;
    for (const c of components) {
      if (!c.inci) continue;
      const ex = this.get(c.inci);
      if (!ex) { this.save({ inci: c.inci, display_name: c.display_name, is_colorant: c.is_colorant }); n++; }
      else if (!ex.display_name && c.display_name) { this.save({ ...ex, display_name: c.display_name }); n++; }
    }
    return n;
  }
  delete(inci) {
    const k = IngredientStore.key(inci); const n = this._items.length;
    this._items = this._items.filter((x) => IngredientStore.key(x.inci) !== k);
    this._persist();
    return this._items.length < n;
  }
  clear() { this._items = []; this._persist(); }
  displayNames() { const o = {}; for (const x of this._items) if (x.display_name) o[x.inci] = x.display_name; return o; }
  colorants() { return new Set(this._items.filter((x) => x.is_colorant).map((x) => x.inci)); }
  /** 工業会リスト等の日本語ヘッダも受ける: INCI名 / 表示名称 / 成分表示名称 … */
  static normalizeRow(r) {
    const pick = (keys) => { for (const k of Object.keys(r)) { const kk = k.replace(/\s+/g, "").toLowerCase(); if (keys.includes(kk)) return r[k]; } return undefined; };
    return {
      inci: pick(["inci_name", "inci", "inci名", "inciname", "inci名称", "英名", "英語名"]),
      display_name: pick(["display_name", "displayname", "表示名称", "成分表示名称", "日本語名", "名称", "和名", "表示名"]),
      is_colorant: pick(["is_colorant", "iscolorant", "着色剤", "colorant"]),
      note: pick(["note", "メモ", "備考", "定義"]),
    };
  }
  importRows(rows) {
    const saved = [], errors = [];
    for (const raw of rows) {
      const r = IngredientStore.normalizeRow(raw);
      if (!r.inci && !r.display_name) continue;
      try { saved.push(this.save({ inci: r.inci, display_name: r.display_name, is_colorant: truthy(r.is_colorant), note: r.note })); }
      catch (e) { errors.push(`${r.inci ?? r.display_name}: ${e.message}`); }
    }
    return { saved, errors };
  }
  importCsv(text) { return this.importRows(parseCsvRecords(text)); }
  exportRows() { return this.listAll().map((x) => ({ inci_name: x.inci, display_name: x.display_name || "", is_colorant: x.is_colorant ? 1 : 0, note: x.note || "" })); }
  exportCsv() { return toCsv(this.exportRows(), INGREDIENT_CSV_COLUMNS); }
}
