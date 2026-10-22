# @magpie-community/opencode-cloudflare-workers-ai-auth

[English](README.md) | [简体中文](README.zh-CN.md) | 日本語

[![CI](https://img.shields.io/badge/CI-passing-34A853.svg)](https://github.com/Guislabert/magpie-cloudflare-workers-ai/actions)
[![バージョン](https://img.shields.io/badge/バージョン-0.0.1--4285F4.svg)](CHANGELOG.md)
[![npm version](https://img.shields.io/badge/npm%20version-0.0.1-EA4335.svg)](https://www.npmjs.com/package/@magpie-community/opencode-cloudflare-workers-ai-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-FBBC05.svg)](https://opensource.org/licenses/MIT)

[OpenCode](https://opencode.ai) 1.x と [magpie](https://usemagpie.ai) 向けのプロバイダー
プラグイン。API トークンで **Cloudflare Workers AI** にサインインし、どのエージェントでも
使えるプロバイダーとして提供します。[models.dev](https://models.dev) から 28+ モデルを
リアルタイム取得、有料専用モデルには目印、
`magpie quota` には 1 日あたりの Neurons 余裕枠が表示されます。

> Cloudflare とは提携・承認関係にありません。

## 必要なもの

| 項目 | 在処 |
|---|---|
| Cloudflare Account ID | ダッシュボードの **Account home** → 右sidebar の 32 桁 hex |
| Cloudflare API トークン | ダッシュボード → アバター → **My Profile** → API Tokens → カスタムトークンを `Account → Workers AI → Edit` で作成（`magpie quota` でプラン名まで表示したい場合は `Account Settings → Read` も追加） |
| magpie | 0.1.1110 以降、または OpenCode 1.x |

トークンに Zone の選択は不要。Free/Paid 両プランに **1 日 10,000 Neurons** の無料枠が
つき、8 つのフロンティアモデルだけ Workers Paid または AI Gateway クレジットが必要です（下記の目印）。

## magpie へのインストール

```sh
magpie plugin add @magpie-community/opencode-cloudflare-workers-ai-auth   # npm から
magpie plugin add /path/to/folder                                        # ローカルコピー
```

サインイン：

```sh
magpie plugin login cloudflare-workers-ai
```

| 入力 | 内容 |
|---|---|
| API Token | 上の Workers AI:Edit トークン |
| Account ID（任意） | 32 桁 hex。空欄ならプラグイン options の `accountId` を使用 |

- サインイン 1 回 = アカウント 1 つ。もう一度サインインするとアカウントを追加
  （例：Free と Paid を並べる）— magpie が自動フェイルオーバーし、`magpie quota`
  には各行が分けて表示されます。
- 同じ Account IDで再サインインすると同じアカウントを差し替え（トークンをローテーション）。
- Cloudflare がトークンを拒んだら、magpie がそのアカウントに申し込み直しを要求します。

## よく使うコマンド

```sh
magpie providers                                                     # サインイン済みか
magpie provider test cloudflare-workers-ai                           # 小さな 1 リクエスト（サンドボックスで約 300 ms）
magpie provider test cloudflare-workers-ai @cf/meta/llama-3.3-70b-instruct-fp8-fast
magpie quota                                                         # プラン + Neurons/日
magpie claude cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast   # Claude Code で使用
magpie codex cloudflare-workers-ai/@cf/openai/gpt-oss-120b                     # Codex でも同様
magpie plugin logout cloudflare-workers-ai                           # サインインを削除
```

モデル名は `cloudflare-workers-ai/@cf/<org>/<model>` — [models.dev](https://models.dev) の
カタログ ID そのままで、1 時間ごとに更新されます。

### OpenCode 1.x での使い方

`opencode.json`：

```json
{ "plugin": ["@magpie-community/opencode-cloudflare-workers-ai-auth"] }
```

その後 `opencode auth login` → Cloudflare Workers AI（同じ 2 項目）。

## 有料専用モデル

Workers Paid または AI Gateway クレジットが必要な 8 モデルは名前に **（Paid）** を付けます：

`@cf/moonshotai/kimi-k2.6`、
`@cf/moonshotai/kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`@cf/zai-org/glm-5.3`、
`@cf/zai-org/glm-5.3-flash`、`@cf/deepseek-ai/deepseek-v4-flash-0731`、
`@cf/deepseek-ai/deepseek-v4.1-flash-1017`、
`@cf/deepseek-ai/deepseek-v4-pro-0813` です。

それ以外のモデルは 1 日 10,000 Neurons の共有枠に含まれ（Paid では超過分に課金）、free バッジは付けません。

## オプション

```sh
magpie plugin options opencode-cloudflare-workers-ai-auth '{"accountId": "…", "discoveryTTLMs": 1800000}'
```

| オプション | 既定 | 説明 |
|---|---|---|
| `accountId` | — | サインインで空欄のときの既定 Account ID |
| `apiKey` | — | 既定トークン（サインインのキーが優先） |
| `baseTemplate` | `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1` | 差し込み対象のテンプレート |
| `discoveryTTLMs` | `3600000` | カタログ再取得間隔 |

## トラブルシューティング

| 表示 | 意味 |
|---|---|
| モデル一覧が空・プロバイダーが見えない | `magpie plugin add .` をやり直し、`magpie plugin --json` の `error` を確認（カタログ取得失敗、トークン拒否） |
| `magpie: the sign-in failed: 需要 API Token` | トークン入力が空 — `magpie plugin login cloudflare-workers-ai` をやり直す |
| `provider test` で 401 `Authentication error` | トークン拒否：権限（`Workers AI:Edit`）を確認し再サインイン |
| `provider test` で 403 | トークンと Account ID の不一致 |
| 400 `No route for that URI` | `plugin add` 再実行後も出るなら、古いプラグインが残っている可能性 — 最新版 URL 正規化で解決済み、要 issue |
| `Model … absent from the current catalog` | models.dev の cloudflare-workers-ai セクションにない ID — 一覧から選ぶ |
| （Paid）モデルで 400 | プランが Free：Workers Paid か AI Gateway クレジットが必要 |
| quota 行がプラン名の代償テキスト | トークンに `Account Settings → Read` がない — 表示だけの問題で Neurons 枠は出る |

## 開発

```sh
node --check src/index.mjs       # パース検査（元リポジトリのバグ）
node --test                     # 11 テスト、ネットワーク不要
sh scripts/sandbox.sh login      # magpie 0.1.1326 を使い捨て HOME で
sh scripts/sandbox.sh test       # サンドボックス内で provider test
sh scripts/sandbox.sh json       # サンドボックス内で plugin --json
```

`scripts/sandbox.sh` の HOME は `.sandbox/`（git 無視）なので、本物の magpie・エージェント・
サインインには触れません。

## プラグイン契約のメモ

- 単一 async プラグイン関数。`config`、`auth.methods`（`password` prompts 付きの 1 つの
  `api` メソッド）、`auth.loader`、`auth.usage`、`provider.models` を書き出す
- `loader(getAuth, provider)` は契約アカウント形（`auth.key`、`auth.metadata.accountId`）を
  読む。OpenCode の旧マルチメソッド形も受ける
- `authorize` は `{ type: "success", key, metadata }` / `{ type: "failed", error }` を返す
- カタログ取得失敗時、`config()` は空のモデル一覧に落として例外化しない。その後アカウント毎の
  `provider.models` がキャッシュ済みカタログを提供
- 単一ファイル、実行時依存ゼロ、ESM、`node >= 20`

## バージョン / ライセンス

| | |
|---|---|
| **バージョン** | [`0.0.1`](CHANGELOG.md) |
| **ライセンス** | [MIT](LICENSE) — Copyright (c) 2026 Guislabert |
| **ランタイム** | Node.js >= 20、ESM のみ |
| **作者** | [@Guislabert](https://github.com/Guislabert) |
| **言語** | [English](README.md) · [简体中文](README.zh-CN.md) |

MIT © [Guislabert](https://github.com/Guislabert)
