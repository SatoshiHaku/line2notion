# line2notion

LINEに送ったレシート画像をCloudflare Workersで受け取り、OpenAIで読み取り、Notionデータベースへ登録するBotです。

## What It Does

```text
LINE image message
-> Cloudflare Workers webhook
-> LINE message content API
-> OpenAI vision model
-> Notion pages API
-> LINE result message
```

Notionには以下のようなプロパティへ登録します。

| Notion property | Type | Value |
| --- | --- | --- |
| `memo` | Title | 店名や主な購入品 |
| `Date` | Date | レシートの日付 |
| `名前` | Select | Buyer name |
| `購入したもの` | Multi-select | 食品、外食、日用品など |
| `金額` | Number | 合計金額 |
| `精算` | Status | `未` |

## Required Secrets

Cloudflare Workerの `Settings > Variables and Secrets` に以下を登録してください。

```text
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
OPENAI_API_KEY
NOTION_API_KEY
NOTION_DATABASE_ID
```

任意で以下も登録できます。

```text
OPENAI_MODEL
NOTION_VERSION
BUYER_A_LINE_USER_ID
BUYER_A_NAME
BUYER_B_LINE_USER_ID
BUYER_B_NAME
DEFAULT_BUYER_NAME
```

`BUYER_A_LINE_USER_ID` / `BUYER_B_LINE_USER_ID` に一致した送信者は、それぞれ `BUYER_A_NAME` / `BUYER_B_NAME` の名前でNotionへ登録されます。未設定の場合は `DEFAULT_BUYER_NAME` が使われます。

LINEに `userid` または `lineid` と送ると、その送信者のLINE userIdを返信します。

## Local Files

`.dev.vars` には秘密情報を入れられますが、Gitには含めないでください。代わりに `.dev.vars.example` を参考にしてください。

## Deploy

```bash
npm install
npm run deploy
```

シークレットはWranglerからも登録できます。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put NOTION_DATABASE_ID
```

デプロイ後、LINE DevelopersのWebhook URLに以下を設定してください。

```text
https://<your-worker-name>.<your-subdomain>.workers.dev/webhook
```

## Safety Notes

Public repositoryにAPIキー、Channel secret、Channel access token、Notion database ID、LINE userId、実レシート画像をコミットしないでください。

過去に秘密情報をチャットやログへ貼った場合は、LINE Developersや各サービス側で再発行してください。
