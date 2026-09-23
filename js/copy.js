// 訴求文の LLM 生成: 成分表と訴求候補 (事実) を詰めたプロンプトを組み、手持ちのチャット
// (ChatGPT / Claude / Gemini 等) に貼る、またはプロンプト入りの URL で直接開く。
// API キーは扱わない (無料ツールにキーを入れる人はいない)。サーバーも介さない。
//
// 機密の扱い: 配合% と原料の商品名は処方の機密なので、プロンプトには絶対に含めない。
// 渡すのは公開情報である全成分表示 (記載順) と、成分辞書の配合目的・由来、候補文、
// 処方全体の集計値 (自然由来指数) だけ。buildClaimPrompt は pct を受け取っても無視する。

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

// 剤型ごとに「使える効能表現」を絞って提示する (56 項目のうち関係する範囲を前に出す)
const EFFICACY_HINTS = [
  { re: /シャンプー|コンディショナー|トリートメント|ヘア|髪|頭皮|スカルプ|リンス/, idx: [0, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15] },
  { re: /洗顔|クレンジング|ボディソープ|石けん|石鹸|ハンドソープ|洗浄/, idx: [16, 17, 18, 20, 21, 23] },
  { re: /化粧水|ローション|乳液|クリーム|美容液|セラム|ジェル|オイル|バーム|ボディ|ハンド|スキンケア|保湿/, idx: [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 55] },
  { re: /日焼け|日やけ|UV|サンスクリーン/, idx: [35, 36, 26, 23] },
  { re: /リップ|口唇|唇/, idx: [41, 42, 43, 44, 45, 46, 47] },
  { re: /ネイル|爪/, idx: [38, 39, 40] },
  { re: /歯|口腔|マウス/, idx: [48, 49, 50, 51, 52, 53, 54] },
  { re: /香水|フレグランス|コロン/, idx: [37] },
];
export function efficacyHints(productType) {
  const t = String(productType || "");
  for (const h of EFFICACY_HINTS) if (h.re.test(t)) return h.idx.map((i) => EFFICACY_56[i]);
  return [];
}

/**
 * 事実 (成分表・候補) と条件から、訴求文生成のプロンプト (system / user) を組む。
 * facts: { jpText, inciText, entries:[{name, purpose, origin}], candidates:[string], naturalIndex:string, freeClaims:[string] }
 *        (entries に pct があっても使わない。配合% は機密)
 * opts:  { productName, productType, target, tone, mode: "cosmetic"|"quasi_drug"|"free", extra, compact }
 */
export function buildClaimPrompt(facts, opts = {}) {
  const mode = opts.mode || "cosmetic";
  const compact = !!opts.compact; // URL に載せる短縮版 (56 項目の全文などを省く)
  const hints = efficacyHints(opts.productType);

  const craft = [
    "あなたは日本の化粧品ブランドで実績のあるコピーライターです。読む人 (生活者) に向けて、使ったときの心地よさや暮らしの中の便益が伝わる文章を書きます。",
    "良いコピーの条件: 便益と使用感が先、成分は裏付けとして後。具体的な情景や感触の言葉を使う。成分名の羅列や「配合目的を分かりやすくお伝えします」のようなメタな説明はしない。",
    "悪い例: 「配合成分から選ぶ、毎日のケア。」「保湿成分とエモリエント成分を配合。」(何も伝わらない)",
    "良い例の型: 「洗い上がりはきしまず、指どおりなめらか。うるおいを守る洗浄設計です。」「乾きやすい肌に、うるおいをとどめる。」(便益 → 根拠)",
    "3 つのキャッチコピーは切り口を変える: ①使用感・便益、②成分や処方の物語、③処方思想 (フリー表示や自然由来など)。",
    "成分名は表示名称のまま使うが、全角英数は半角に整えてよい (ＢＧ → BG)。",
  ];

  const rules = [];
  if (mode === "cosmetic") {
    rules.push(
      "薬事の枠 (化粧品): 効能効果は薬機法上の化粧品の効能の範囲 (56 項目) に収める。ただしこの範囲の表現は積極的に使ってよい (例: うるおいを与える、肌を整える、毛髪をしなやかにする、日やけを防ぐ)。範囲内の言い換え (「うるおいで満たす」「なめらかに整える」) も可。",
      hints.length ? "この剤型で特に使える効能表現: " + hints.join("／") : "",
      compact ? "" : "効能の範囲 (全 56 項目): " + EFFICACY_56.join("／"),
      "範囲外の効果 (治療・予防・美白・シワ改善・ニキビ改善・アンチエイジングなど) は示唆しない。成分に効果を断定させず、「〇〇 (保湿成分) 配合」のように配合目的で語る。",
      compact ? "" : "使ってはいけない表現の例: " + NG_EXAMPLES + "。",
    );
  } else if (mode === "quasi_drug") {
    rules.push("薬事の枠 (医薬部外品): 有効成分として承認された効能は書ける。それ以外の成分は化粧品と同じく配合目的で語る。承認外の効能、治療的表現、最上級表現、根拠のない数値は使わない。");
  } else {
    rules.push("表現の法規制は考慮しなくてよい。ただし事実 (成分表と候補) に無いことは書かない。");
  }
  rules.push(
    "事実の枠: 成分表と訴求候補だけを根拠にする。書かれていない配合成分・数値・試験結果・受賞歴・産地は作らない。",
    "配合量は非開示なので、量の多寡 (たっぷり、高配合、〇%) は書かない。自然由来指数は幅があれば下限を使うか、数値を出さない。",
    "剤型・用途が未指定なら成分表から妥当に推定して書く (洗浄剤が主体ならシャンプーや洗浄料、油剤と乳化剤があればクリーム、など)。推定した旨を「注意」に一言書く。",
  );

  const output = [
    "出力 (Markdown、見出し付き):",
    "1. キャッチコピー (3 案、各 30 字以内、切り口①②③)",
    "2. 商品説明文 (2 案、各 120〜160 字。便益 → 使用感 → 根拠の順で、読んで心地よい文)",
    "3. 成分の見せ方 (訴求候補の成分を、パッケージや LP で使える短い一文にする。3〜5 個)",
    "4. 使える表示 (フリー表示・自然由来指数のうち、そのまま載せられるもの)",
    "5. 注意 (根拠が弱い表現、確認が必要な点。簡潔に)",
  ];

  const system = [...craft, ...rules.filter(Boolean), ...output].join("\n");

  const lines = [];
  lines.push("# 製品情報");
  lines.push(`- 製品名: ${opts.productName || "(未定。仮称でよい)"}`);
  lines.push(`- 剤型・カテゴリ: ${opts.productType || "(未指定。成分表から推定)"}`);
  lines.push(`- ターゲット: ${opts.target || "(未指定。成分と剤型から想定)"}`);
  lines.push(`- トーン: ${opts.tone || "生活者に語りかける、具体的で心地よい"}`);
  if (opts.extra) lines.push(`- 補足: ${opts.extra}`);
  lines.push("", "# 全成分表示 (記載順)", facts.jpText || "");
  if (!compact) lines.push("", "INCI: " + (facts.inciText || ""));
  const detailed = (facts.entries || []).filter((e) => e.purpose || e.origin);
  if (detailed.length && !compact) {
    lines.push("", "# 成分ごとの情報 (配合目的, 由来)  ※配合量は非開示");
    for (const e of detailed) lines.push(`- ${e.name}: ${[e.purpose, e.origin].filter(Boolean).join(", ")}`);
  }
  lines.push("", "# 訴求候補 (事実)", ...(facts.candidates || []).map((c) => `- ${c}`));
  if (facts.naturalIndex) lines.push(`- 自然由来指数: ${facts.naturalIndex}`);
  if (facts.freeClaims?.length) lines.push(`- 表示できるフリー表示: ${facts.freeClaims.join("、")}`);
  lines.push("", "配合量は非開示です。量の多寡を推測して書かないでください。上記の事実を根拠に、指定の構成で文案を作ってください。");
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
  // Gemini はプロンプト入り URL を公式には受け付けない (拡張機能が必要) → コピーしてから開く
  { id: "gemini", label: "Gemini で開く (コピーして貼る)", url: () => "https://gemini.google.com/app", copyFirst: true },
];
export const URL_SAFE_LIMIT = 16000; // エンコード後の目安 (主要ブラウザ・サイトが受ける範囲)。超える場合はコピーに誘導

export function chatLinks(promptText) {
  return CHAT_TARGETS.map((c) => { const url = c.url(promptText); return { ...c, href: url, tooLong: !c.copyFirst && url.length > URL_SAFE_LIMIT }; });
}
