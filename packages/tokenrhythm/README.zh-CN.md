# @magpie-community/opencode-tokenrhythm-auth

TokenRhythm（基元律动，<https://tokenrhythm.studio>）的 magpie / OpenCode 供应商插件。

[English](README.md)

## 登录 Sign-ins

- **浏览器登录（托管密钥 + 余额）** — OAuth2 + PKCE loopback（OpenSquilla 集成客户端
  `opensquilla-desktop`）。magpie 会显示授权链接，打开并登录后插件自动完成回调、
  获取/复用账户的托管模型密钥；余额卡片实时显示（两位小数）。
- **仅 API 密钥** — 粘贴 TokenRhythm 模型密钥；模型可用，余额卡片需要 OAuth 会话。

```bash
magpie plugin add <本地路径或发布名>
magpie plugin login tokenrhythm
```

## 密钥能力 Key surface

统一基础地址 Base URL: `https://tokenrhythm.studio/v1`
（文档 Docs: <https://tokenrhythm.studio/docs/api-integration>）

| 能力 Capability | 接口 Endpoint |
| --- | --- |
| 模型列表 Model list | `GET /v1/models` |
| OpenAI 对话 OpenAI chat | `POST /v1/chat/completions` |
| Anthropic 对话 Anthropic messages | `POST /v1/messages` |
| 向量嵌入 Embeddings | `POST /v1/embeddings` |
| Wan 3.0 视频生成 Video generations | `POST /v1/videos/generations` |
| JEV 决策（灰度）JEV decision | `POST /v1/decision`、`POST /v1/systemone` |

- 模型目录运行时从 `GET /v1/models` 获取（30 个模型），经 magpie 网关以
  `tokenrhythm-plugin/<模型>` 提供；magpie 网关同时暴露 OpenAI 与 Anthropic 协议。
- `NeoHorse-Jev-4B` 作为 System One 决策模型（`decides: true`）接入 magpie
  路由组分类器，请求发往 `{BASE}/systemone`；空的选项描述自动改写为选项键，
  以通过 TokenRhythm 的校验（否则 HTTP 422）。
- 同一密钥可直接调用 embeddings / videos 端点（Wan 3.0）。

```sh
# OpenAI 对话
curl https://tokenrhythm.studio/v1/chat/completions \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 对话
curl https://tokenrhythm.studio/v1/messages \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# 向量嵌入
curl https://tokenrhythm.studio/v1/embeddings \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hello"}'

# Wan 3.0 视频生成
curl https://tokenrhythm.studio/v1/videos/generations \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"wan3.0","prompt":"a sailboat at sunset"}'

# JEV 决策
curl https://tokenrhythm.studio/v1/decision \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"NeoHorse-Jev-4B","criteria":[{"key":"fast","description":"优先速度"}],"input":"..."}'
```

## 配置 Configuration

| 选项 Option | 默认 Default | 说明 Description |
| --- | --- | --- |
| `create_key` | `true` | 浏览器登录后自动获取/复用托管模型密钥。 |
| `origin` | `https://tokenrhythm.studio` | TokenRhythm 站点地址。 |
| `modelBase` | `<origin>/v1` | OpenAI 兼容模型接口地址。 |
| `loginTimeoutMs` | `300000` | 浏览器登录等待时长。 |

## 许可 License

MIT
