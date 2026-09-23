// 成分表ジェネレーターの使い方を自動操作で録画する (Playwright)。
// 出力: OUT/video.webm, OUT/shots/NN-*.png。字幕はページに注入した帯で描く (後編集不要)。
import { chromium } from "playwright";
import { mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.URL || "http://127.0.0.1:8765/";
const OUT = process.env.OUT || "./rec";
mkdirSync(join(OUT, "shots"), { recursive: true });

const browser = await chromium.launch({ headless: true, slowMo: 40 });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: "ja-JP",
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

// 字幕帯と、クリック位置を示すカーソル風のマーカー
await page.addInitScript(() => {
  window.__cap = (text, sub) => {
    let b = document.getElementById("__cap");
    if (!b) {
      b = document.createElement("div"); b.id = "__cap";
      b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(20,30,40,.92);color:#fff;padding:14px 28px;font:600 22px/1.4 -apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.3);transition:opacity .25s";
      document.body.appendChild(b);
    }
    b.innerHTML = text + (sub ? `<div style="font-weight:400;font-size:16px;opacity:.85;margin-top:4px">${sub}</div>` : "");
    b.style.opacity = text ? "1" : "0";
  };
  window.__ring = (x, y) => {
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border:3px solid #18bc9c;border-radius:50%;z-index:99998;pointer-events:none;animation:__pulse .6s ease-out forwards`;
    if (!document.getElementById("__ringstyle")) { const s = document.createElement("style"); s.id = "__ringstyle"; s.textContent = "@keyframes __pulse{from{transform:scale(.6);opacity:1}to{transform:scale(1.8);opacity:0}}"; document.head.appendChild(s); }
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
  };
});

let n = 0;
const wait = (ms) => page.waitForTimeout(ms);
const cap = async (text, sub = "") => { await page.evaluate(([t, s]) => window.__cap(t, s), [text, sub]); };
const shot = async (name) => { n++; await page.screenshot({ path: join(OUT, "shots", `${String(n).padStart(2, "0")}-${name}.png`) }); };
const click = async (sel, opts = {}) => {
  const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 }); await page.evaluate(([x, y]) => window.__ring(x, y), [box.x + box.width / 2, box.y + box.height / 2]); await wait(250); }
  await el.click(opts); await wait(400);
};
const typeSlow = async (sel, text) => { const el = page.locator(sel).first(); await el.click(); await el.fill(""); await el.type(text, { delay: 35 }); };

await page.goto(URL, { waitUntil: "networkidle" });
await wait(600);
await cap("成分表ジェネレーター　1 分で分かる使い方", "原料の構成を登録 → 処方を貼る → 全成分表示・フリー表示・訴求点が一度に出ます");
await shot("intro"); await wait(3200);

// ① 原料登録
await click('.tab[data-tab="materials"]');
await cap("① 原料登録", "まずは「サンプル原料を読込」で 33 件の例を入れてみます");
await wait(1500);
await click("#mat-sample-btn"); await wait(1200);
await shot("materials-loaded");
await cap("原料ごとに INCI と原料中の % を登録します", "ブレンド原料は活性分と水を分けて入れると、成分表で水が合算されます");
await click("#mat-table tbody tr:nth-child(3)"); await wait(2600);
await shot("material-edit");

// ② 成分登録
await click('.tab[data-tab="ingredients"]');
await cap("② 成分登録（INCI ↔ 表示名称）", "基本成分 300 件は自動で入っています。お手元の INCI と表示名称の対応表を CSV で追加できます");
await wait(900);
await typeSlow("#ing-search", "glyc"); await wait(1800);
await shot("ingredients");

// ③ 処方をコピペ
await click('.tab[data-tab="label"]');
await cap("③ 処方をコピペで入力", "1 行 1 原料「原料名 配合%」。Excel の 2 列コピーでも OK");
await wait(800);
await typeSlow("#paste-input", "精製水\t54.9\nSLES-27\t30\nCAPB-30\t8\nココグルコシド-50\t2\nグリセリン\t2\nポリクオタニウム-10\t0.3\nパンテノール\t0.5\n防腐剤ブレンド PE-9010\t1\nEDTA-2Na\t0.1\nクエン酸\t0.2\n塩化Na\t1");
await wait(500);
await click("#paste-btn"); await wait(1200);
await shot("pasted");
await cap("全成分表示が記載順で出ます", "配合量の多い順。1% 以下は「順不同可」、着色剤は末尾。同じ INCI は原料をまたいで合算");
await page.locator("#label-output").scrollIntoViewIfNeeded(); await wait(3000);
await shot("label");

// ④ 訴求点・⑤ フリー表示
await cap("④ 訴求点の候補", "配合目的・由来・自然由来指数（ISO 16128 の考え方）・使えるフリー表示を候補として整理");
await page.locator("details.claims").first().scrollIntoViewIfNeeded(); await wait(3000);
await shot("claims");
await cap("⑤ フリー表示チェック（17 種）", "パラベン・防腐剤・旧表示指定成分・無香料・無着色・シリコン・PEG… 該当成分まで表示");
const claimsTables = page.locator("details.claims");
await claimsTables.nth((await claimsTables.count()) - 1).scrollIntoViewIfNeeded(); await wait(3200);
await shot("free-claims");

// ⑥ 未登録原料の登録ウィンドウ
await page.evaluate(() => window.scrollTo(0, 0)); await wait(400);
await cap("⑥ 未登録の原料があれば、その場で登録", "貼り付けた処方に新しい原料が混ざっていても止まりません");
await typeSlow("#paste-input", "精製水\t70\n新原料テスト\t30");
await click("#paste-btn"); await wait(1200);
await shot("register-dialog");
await page.locator("#reg-comp-table tbody tr input").first().fill("Glycerin");
await page.locator("#reg-comp-table tbody tr input").first().dispatchEvent("change"); await wait(600);
await cap("INCI と原料中の % を入れて「保存して次へ」", "登録が終わると処方に自動で反映されます");
await wait(1200);
await click("#reg-save-btn"); await wait(1500);
await shot("registered");

// ⑦ 自社ルール
await click('.tab[data-tab="rules"]');
await cap("⑦ フリー表示の自社ルール", "表示のオン・オフ、該当・除外にする成分の追加、自分の表示の作成。正規表現は不要");
await wait(900);
await click("#rule-table tbody tr:nth-child(11)"); await wait(2600);
await shot("rules");

// まとめ
await click('.tab[data-tab="label"]');
await cap("無料・登録不要・処方データは送信されません", "kmura-09.github.io/cosme-label");
await wait(3200);
await shot("end");
await cap("");

const video = page.video();
await ctx.close();
const path = await video.path();
renameSync(path, join(OUT, "video.webm"));
await browser.close();
console.log("video:", join(OUT, "video.webm"), "| shots:", readdirSync(join(OUT, "shots")).length);
