# magpie-breeze-blue

## 1. 这是什么

`magpie-breeze-blue` 是 Magpie 的 Breeze Blue TTS provider 插件。它把 Magpie 网关的 OpenAI 兼容 `POST /v1/audio/speech` 请求转换成 Breeze 官方 `/v1/text-to-speech/{voice_id}` 请求，并通过 `auth.usage` 把 Breeze 余额显示在 Magpie 的 provider 卡片/usage 中。

- provider id：`breeze`
- 显示名：`BreezeBlue`
- 模型：`breeze-tts-2`（显示名 `Breeze TTS 2`）
- 联网目标只有 `https://api.breeze.blue`
- 图标：`magpie.icon` 指向 BreezeBlue 官方 `https://breezeblue.ai/favicon.png`，不打包进本项目；图标版权归 BreezeBlue，如官方不希望第三方使用，可删除该字段或换回自绘图标。

## 2. 安装

在项目根目录执行：

```bash
magpie plugin add ./            # 本地目录
# 或发布后：magpie plugin add magpie-breeze-blue
magpie plugin login breeze
```

登录时填入 Breeze API Key（`brz_…`）。Key 保存在 Magpie 中，不会写进本项目的文件。

## 3. 使用 `/v1/audio/speech`

Magpie 网关默认监听 `http://127.0.0.1:3425`。请求体与 OpenAI TTS 一致：

```json
{
  "model": "breeze/breeze-tts-2",
  "input": "晚安啦",
  "voice": "voc_...",
  "response_format": "mp3",
  "instructions": "用温柔的语气说",
  "speed": 1.05
}
```

`voice` 必须是 Breeze 账号下的真实音色 ID（`voc_…`），本项目不硬编码任何用户的音色。

对应的 `curl`：

```bash
curl http://127.0.0.1:3425/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"breeze/breeze-tts-2","input":"晚安啦","voice":"voc_...","response_format":"mp3","instructions":"用温柔的语气说","speed":1.05}' \
  --output out.mp3
```

### 3.1 参数

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `input` | 是 | — | 要朗读的文本；空白字符串会返回 400 |
| `voice` | 是 | — | Breeze 音色 ID，例如 `voc_...`；会作为 URL path 段编码 |
| `response_format` | 否 | `mp3` | 见 3.2 的格式映射；未知值按 `mp3` |
| `speed` | 否 | `1` | 夹取到 0.5–2；等于 1 时不发送 |
| `instructions` | 否 | 不发送 | 语气/情绪指令 |
| `language_code` | 否 | `zh` | Breeze 扩展字段，两位 ISO 639-1 代码 |
| `model_id` | 否 | `breeze-tts-2` | Breeze 扩展字段 |
| `guidance_scale` | 否 | `1` | Breeze 扩展字段，夹取到 1–10；等于 1 时不发送 |
| `use_speaker_boost` | 否 | `false` | Breeze 扩展字段；仅当值为 `true` 时发送 |

`voice_settings` 只在 `speed`、`guidance_scale` 或 `use_speaker_boost` 有非默认值时才出现在 Breeze 请求体中。

### 3.2 格式映射

| `response_format` | Breeze `output_format` |
| --- | --- |
| `mp3` | `mp3` |
| `wav` | `wav_24000` |
| `opus` | `opus` |
| `aac` | `aac_24000_128` |
| `flac` | `flac_24000` |
| `pcm` | `pcm_24000` |
| 其他值 | `mp3` |

成功时原样返回 Breeze 的音频二进制和 `content-type`；Breeze 没有给出时默认 `audio/mpeg`。

### 3.3 错误

Breeze 返回 `{code, detail, error}` 时，插件保留 HTTP 状态，并转换成 OpenAI 形状：

```json
{
  "error": {
    "message": "voice not found",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_voice"
  }
}
```

本地校验失败返回 400；非 `/v1/audio/speech` 路径返回 404；非 POST 返回 405。所有错误都不会把 API Key 写进消息或日志。

## 4. 余额

`auth.usage` 会请求 Breeze `GET /v1/balance`，并返回 Magpie 的 wallet window：

```js
{
  plan: 'BreezeBlue',
  windows: [{ name: '余额', balance: 1635.6, unit: '积分' }]
}
```

`settlement_pending` 为 `true` 时，窗口会带上 `aside: true`，避免路由把它当作会立即耗尽账户的额度。查询失败时返回 `windows: []` 和 `error` 文本，不会把异常抛到 Magpie 外层。

余额只显示在 Magpie 的 provider 卡片/usage 中。用量卡片还会显示一行「在 breezeblue.ai/app 手动领取」的提示。

## 5. 网络与安全

- 插件只访问 `https://api.breeze.blue`：`/v1/text-to-speech/{voice_id}` 和 `/v1/balance`。
- 自定义 `fetch` 只处理 `/v1/audio/speech`，其他路径直接返回 JSON 错误，不会转发到 Breeze。
- 发往 Breeze 的请求只带 Breeze 的 `xi-api-key`；不会转发 Magpie 收到的 `authorization` 等请求头。
- API Key 不会出现在日志、错误消息或返回体中。
- 包本身不引入任何 npm 运行时依赖。

## 6. 兼容性

需要支持 provider 插件与 `/v1/audio/speech` 的 Magpie 版本。开发时参考 Magpie `0.1.2800` 的插件接口（`config` / `auth.loader` / `auth.usage` / `provider.models`）；更低版本未验证。

测试运行器需要 Node.js 18 或更高版本；插件本身运行在 Magpie 的插件宿主中。

## 7. 开发与测试

```bash
node --test
```

测试使用 `node:test`，通过注入 `fetchImpl` 覆盖请求映射、错误透传和余额解析，不访问真实 Breeze 网络。

## 8. 许可证

MIT，见 `LICENSE`。
