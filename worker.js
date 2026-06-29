export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("line receipt bot is running", { status: 200 });
  },
};

async function handleWebhook(request, env, ctx) {
  const body = await request.text();
  const signature = request.headers.get("x-line-signature") || "";
  console.log(`webhook received: ${body.length} bytes`);

  const isValid = await verifyLineSignature(
    body,
    env.LINE_CHANNEL_SECRET,
    signature
  );

  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);
  console.log(`webhook events: ${(payload.events || []).length}`);

  ctx.waitUntil(
    Promise.all((payload.events || []).map((event) => handleLineEvent(event, env)))
  );

  return new Response("OK", { status: 200 });
}

async function handleLineEvent(event, env) {
  console.log(`event type: ${event.type}`);
  if (event.type !== "message") return;
  if (!event.replyToken) return;

  try {
    console.log(`message type: ${event.message.type}`);

    if (event.message.type === "text") {
      const text = event.message.text.trim().toLowerCase();
      if (text === "userid" || text === "user id" || text === "lineid") {
        await replyMessage(env, event.replyToken, [
          {
            type: "text",
            text: `LINE userId: ${event.source?.userId || "unknown"}`,
          },
        ]);
        return;
      }
    }

    if (event.message.type === "image") {
      await replyMessage(env, event.replyToken, [
        {
          type: "text",
          text: "レシート画像を受け取りました。読み取りが終わったら結果を送ります。",
        },
      ]);

      const imageBytes = await fetchLineMessageContent(env, event.message.id);
      console.log(`image bytes: ${imageBytes.byteLength}`);

      const receipt = await analyzeReceiptWithOpenAI(env, imageBytes);
      console.log(`receipt parsed: ${JSON.stringify(receipt)}`);

      const buyerName = resolveBuyerName(env, event.source?.userId);
      const notionUrl = await createNotionPage(env, receipt, buyerName);
      console.log(`Notion page created: ${notionUrl}`);

      await pushMessage(env, event.source.userId, [
        {
          type: "text",
          text: formatReceiptReply(receipt, notionUrl, buyerName),
        },
      ]);
      return;
    }

    await replyMessage(env, event.replyToken, [
      {
        type: "text",
        text: "レシート写真を送ってください。",
      },
    ]);
  } catch (error) {
    console.log(`handleLineEvent error: ${error.stack || error.message}`);

    const errorText = error.message || "unknown error";
    const messages = [
      {
        type: "text",
        text:
          "読み取りに失敗しました。\n" +
          `原因: ${errorText.slice(0, 120)}\n` +
          "もう少し明るく、レシート全体が入るように撮って再送してください。",
      },
    ];

    if (event.source && event.source.userId) {
      await pushMessage(env, event.source.userId, messages);
    } else {
      await replyMessage(env, event.replyToken, messages);
    }
  }
}

async function pushMessage(env, userId, messages) {
  if (!userId) {
    console.log("LINE push skipped: userId is empty");
    return;
  }

  console.log(`pushing message count: ${messages.length}`);

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.log(`LINE push error: ${response.status} ${errorText}`);
  } else {
    console.log("LINE push ok");
  }
}

async function fetchLineMessageContent(env, messageId) {
  const response = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE content error: ${response.status} ${errorText}`);
  }

  return response.arrayBuffer();
}

async function analyzeReceiptWithOpenAI(env, imageBytes) {
  const base64Image = arrayBufferToBase64(imageBytes);
  const model = env.OPENAI_MODEL || "gpt-4o-2024-05-13";
  console.log(`calling OpenAI model: ${model}`);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(25000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildReceiptPrompt(),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "low",
              },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
      temperature: 0.1,
    }),
  });

  const data = await response.json();
  console.log(`OpenAI status: ${response.status}`);

  if (!response.ok) {
    console.log(JSON.stringify(data));
    throw new Error(`OpenAI error: ${response.status}`);
  }

  const text = data.choices?.[0]?.message?.content || "";
  console.log(`OpenAI text length: ${text.length}`);

  const jsonText = extractJsonObject(text);
  return JSON.parse(jsonText);
}

async function createNotionPage(env, receipt, buyerName) {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) {
    throw new Error("Notion secrets are missing");
  }

  const amount = normalizeAmount(receipt["金額"]);
  const date = receipt["日付"] || null;
  const memo = formatNotionMemo(receipt["メモ"], date);
  const category = receipt["カテゴリ"] || "未分類";

  const properties = {
    memo: {
      title: [
        {
          text: {
            content: memo,
          },
        },
      ],
    },
    金額: {
      number: amount,
    },
    購入したもの: {
      multi_select: [
        {
          name: category,
        },
      ],
    },
    精算: {
      status: {
        name: "未",
      },
    },
  };

  if (date) {
    properties.Date = {
      date: {
        start: date,
      },
    };
  }

  if (buyerName) {
    properties["名前"] = {
      select: {
        name: buyerName,
      },
    };
  }

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": env.NOTION_VERSION || "2022-06-28",
    },
    body: JSON.stringify({
      parent: {
        database_id: env.NOTION_DATABASE_ID,
      },
      properties,
    }),
  });

  const data = await response.json();
  console.log(`Notion status: ${response.status}`);

  if (!response.ok) {
    console.log(JSON.stringify(data));
    throw new Error(`Notion error: ${response.status} ${data.message || ""}`);
  }

  return data.url || "";
}

function buildReceiptPrompt() {
  const schemaExample = {
    金額: 1234,
    カテゴリ: "公共料金 or デバイス or 日用品 or 外食 or 食品 or 家具 or ごみ収集 or 遊び or お土産 or 旅行 or ホテル",
    日付: "YYYY-MM-DD",
    メモ: "店名や主な購入品",
  };

  return [
    "以上のレシート内容から情報を抽出してください。",
    "必ずJSON形式で出力してください。",
    "```jsonなどのコードブロックで囲まないでください。",
    "説明文、Markdown、前置き、後書きは不要です。",
    "itemsや明細行は返さないでください。",
    "金額は合計金額のみを、円記号やカンマを含めない数値で返してください。",
    "日付はレシートの日付をYYYY-MM-DD形式で返してください。読めない場合はnullにしてください。",
    "メモには店名や主な購入品を短く書いてください。",
    "カテゴリは次のいずれかだけを選択してください: 公共料金, デバイス, 日用品, 外食, 食品, 家具, ごみ収集, 遊び, お土産, 旅行, ホテル",
    "カテゴリ選択ルール:",
    "- コンビニ弁当・外食店 -> 外食",
    "- スーパーの食材・調味料 -> 食品",
    "- 洗剤・シャンプーなど -> 日用品",
    "- 電気・ガス・水道代 -> 公共料金",
    "- スマホ・PC関連 -> デバイス",
    "- その他は最も適切なカテゴリを選択してください。",
    JSON.stringify(schemaExample),
  ].join("\n");
}

function formatReceiptReply(receipt, notionUrl, buyerName) {
  const amount = receipt["金額"];
  const total =
    typeof amount === "number"
      ? `${amount.toLocaleString("ja-JP")}円`
      : typeof amount === "string" && amount.length > 0
        ? `${amount}円`
        : "不明";

  return [
    "読み取りました。",
    `合計: ${total}`,
    `カテゴリ: ${receipt["カテゴリ"] || "不明"}`,
    `日付: ${receipt["日付"] || "不明"}`,
    `メモ: ${receipt["メモ"] || "不明"}`,
    `名前: ${buyerName || "未設定"}`,
    notionUrl ? `Notion: ${notionUrl}` : "Notionに登録しました。",
  ].join("\n");
}

function formatNotionMemo(memo, date) {
  const memoText = memo || "レシート";
  if (!date) return memoText;
  if (memoText.includes(date)) return memoText;

  return `${date} ${memoText}`;
}

function resolveBuyerName(env, userId) {
  if (!userId) return env.DEFAULT_BUYER_NAME || null;
  if (env.BUYER_A_LINE_USER_ID && userId === env.BUYER_A_LINE_USER_ID) {
    return env.BUYER_A_NAME || "Buyer A";
  }
  if (env.BUYER_B_LINE_USER_ID && userId === env.BUYER_B_LINE_USER_ID) {
    return env.BUYER_B_NAME || "Buyer B";
  }
  return env.DEFAULT_BUYER_NAME || null;
}

function normalizeAmount(amount) {
  if (typeof amount === "number") return amount;
  if (typeof amount === "string") {
    const numericText = amount.replace(/[^0-9.-]/g, "");
    return numericText ? Number(numericText) : null;
  }

  return null;
}

async function replyMessage(env, replyToken, messages) {
  console.log(`replying message count: ${messages.length}`);

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.log(`LINE reply error: ${response.status} ${errorText}`);
  } else {
    console.log("LINE reply ok");
  }
}

async function verifyLineSignature(body, channelSecret, signature) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function extractJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`JSON not found in OpenAI response: ${text}`);
  }

  return match[0];
}
