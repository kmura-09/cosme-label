// 訴求文の LLM 生成: 成分表と訴求候補 (事実) を詰めたプロンプトを組み、手持ちのチャット
// (ChatGPT / Claude / Gemini 等) に貼る、またはプロンプト入りの URL で直接開く。
// API キーは扱わない (無料ツールにキーを入れる人はいない)。サーバーも介さない。

// 化粧品の効能の範囲 (56 項目、平成23年 薬食発0721第1号)
export const EFFICACY_56 = [
  "頭皮、毛髪を清浄にする", "香りにより毛髪、頭皮の不快臭を抑える", "頭皮、毛髪をすこやかに保つ", "毛髪にはり、こしを与える",
  "頭皮、毛髪にうるおいを与える", "頭皮、毛髪のうるおいを保つ", "毛髪をしなやかにする", "クシどおりをよくする", "毛髪のつやを保つ",
  "毛髪につやを与える", "フケ、カユミがとれる", "フケ、カユミを抑える", "毛髪の水分、油分を補い保つ", "裂毛、切毛、枝毛を防ぐ",
  "髪型を整え、保持する", "毛髪の帯電を防止する", "（汚れをおとすことにより）皮膚を清浄にする", "（洗浄により）ニキビ、アセモを防ぐ（洗顔料）",
  "肌を整える", "肌のキメを整える", "皮膚をすこやかに保つ", "肌荒れを防ぐ", "肌をひきしめる", "皮膚にうるおいを与える",
  "皮膚の水分、油分を補い保つ", "皮膚の柔軟性を保つ", "皮膚を保護する", "皮膚の乾燥を防ぐ", "肌を柔らげる", "肌にはりを与える",
  "肌にツヤを与える", "肌を滑らかにする", "ひげを剃りやすくする", "ひげそり後の肌を整える", "あせもを防ぐ（打粉）", "日やけを防ぐ",
  "日やけによるシミ、ソバカスを防ぐ", "芳香を与える", "爪を保護する", "爪をすこやかに保つ", "爪にうるおいを与える", "口唇の荒れを防ぐ",
  "口唇のキメを整える", "口唇にうるおいを与える", "口唇をすこやかにする", "口唇を保護する。口唇の乾燥を防ぐ", "口唇の乾燥によるカサツキを防ぐ",
  "口唇を滑らかにする", "ムシ歯を防ぐ（使用時にブラッシングを行う歯みがき類）", "歯を白くする（同上）", "歯垢を除去する（同上）",
  "口中を浄化する（歯みがき類）", "口臭を防ぐ（歯みがき類）", "歯のやにを取る（同上）", "歯石の沈着を防ぐ（同上）", "乾燥による小ジワを目立たなくする",
];

const NG_EXAMPLES = "美白、シミが消える、シワ改善、ニキビが治る、アンチエイジング、若返り、細胞の活性化、コラーゲン生成、殺菌、抗炎症、" +
  "浸透（角質層まで、と限定しない表現）、医師推奨、最上級表現（No.1、最高）、根拠のない数値";

/**
 * 事実 (成分表・候補) と条件から、訴求文生成のプロンプト (system / user) を組む。
 * facts: { jpText, inciText, entries:[{name, pct, purpose, origin}], candidates:[string], naturalIndex:string, freeClaims:[string] }
 * opts:  { productName, productType, target, tone, length, mode: "cosmetic"|"quasi_drug"|"free", extra }
 */
export function buildClaimPrompt(facts, opts = {}) {
  const mode = opts.mode || "cosmetic";
  const compact = !!opts.compact; // URL に載せる短縮版 (56 項目の全文を省く)
  const rules = [];
  if (mode === "cosmetic") {
    rules.push("この製品は化粧品です。効能効果の表現は薬機法上の化粧品の効能の範囲 (56 項目) に収め、それ以外の効果 (治療・予防・美白・シワ改善など) を示唆しないでください。",
      compact ? "" : "効能の範囲: " + EFFICACY_56.join("／"),
      "成分ごとの効果を断定せず、「〇〇（保湿成分）配合」のように配合目的として表現してください。",
      compact ? "" : "使ってはいけない表現の例: " + NG_EXAMPLES + "。");
  } else if (mode === "quasi_drug") {
    rules.push("この製品は医薬部外品です。有効成分として承認された効能 (指定された範囲) は書けますが、それ以外の成分の効果は化粧品と同じく配合目的の表現に留めてください。",
      "承認外の効能、治療的表現、最上級表現、根拠のない数値は使わないでください。");
  } else {
    rules.push("表現の法規制は考慮しなくてよいですが、成分表と候補にない事実を作らないでください。");
  }
  rules.push("事実は下記の成分表と訴求候補だけを根拠にし、書かれていない配合成分・数値・試験結果・受賞歴を作らないでください。",
    "自然由来指数に幅がある場合は幅の下限を使うか、数値を出さないでください。");

  const system = [
    "あなたは日本の化粧品ブランドのコピーライター兼薬事担当です。与えられた成分表と訴求候補 (事実) から、商品説明の文案を日本語で作ります。",
    ...rules.filter(Boolean),
    "出力は次の構成で、見出し付きの Markdown にしてください:",
    "1. キャッチコピー案 (3 案、各 30 字以内)",
    "2. 商品説明文 (2 案、各 120〜160 字)",
    "3. 成分の説明 (箇条書き、訴求候補にある成分だけ)",
    "4. フリー表示・数値訴求 (使えるもの)",
    "5. 注意 (根拠が弱い表現、確認が必要な点)",
  ].join("\n");

  const lines = [];
  lines.push(`# 製品情報`);
  lines.push(`- 製品名: ${opts.productName || "(未定)"}`);
  lines.push(`- 剤型・カテゴリ: ${opts.productType || "(未指定)"}`);
  lines.push(`- ターゲット: ${opts.target || "(未指定)"}`);
  lines.push(`- トーン: ${opts.tone || "誠実で分かりやすい"}`);
  if (opts.extra) lines.push(`- 補足: ${opts.extra}`);
  lines.push("", "# 全成分表示 (記載順)", facts.jpText || "");
  if (!compact) lines.push("", "INCI: " + (facts.inciText || ""));
  if (facts.entries?.length && !compact) {
    lines.push("", "# 成分ごとの情報 (配合%, 配合目的, 由来)");
    for (const e of facts.entries) lines.push(`- ${e.name}: ${e.pct}%${e.purpose ? `, ${e.purpose}` : ""}${e.origin ? `, ${e.origin}` : ""}`);
  }
  lines.push("", "# 訴求候補 (事実)", ...(facts.candidates || []).map((c) => `- ${c}`));
  if (facts.naturalIndex) lines.push(`- 自然由来指数: ${facts.naturalIndex}`);
  if (facts.freeClaims?.length) lines.push(`- 表示できるフリー表示: ${facts.freeClaims.join("、")}`);
  lines.push("", "上記の事実だけを根拠に、指定の構成で文案を作ってください。");
  return { system, user: lines.join("\n") };
}

/** プロンプトを 1 本のテキストに (手持ちの LLM に貼る用)。 */
export function promptAsText({ system, user }) {
  return `${system}\n\n---\n\n${user}`;
}


/** プロンプト入りで各チャットを開く URL。URL 長の上限があるので短縮版プロンプトを使う。 */
export const CHAT_TARGETS = [
  { id: "chatgpt", label: "ChatGPT で開く", url: (t) => `https://chatgpt.com/?q=${encodeURIComponent(t)}` },
  { id: "claude", label: "Claude で開く", url: (t) => `https://claude.ai/new?q=${encodeURIComponent(t)}` },
];
export const URL_SAFE_LIMIT = 16000; // エンコード後の目安 (主要ブラウザ・サイトが受ける範囲)。超える場合はコピーに誘導

export function chatLinks(promptText) {
  return CHAT_TARGETS.map((c) => { const url = c.url(promptText); return { ...c, href: url, tooLong: url.length > URL_SAFE_LIMIT }; });
}
