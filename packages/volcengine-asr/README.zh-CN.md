# magpie 的火山引擎语音识别插件

[English](README.md)

在 magpie 兼容 OpenAI 的 `POST /v1/audio/transcriptions` 上使用火山引擎豆包语音识别，
用你自己的火山引擎语音 API Key 登录。任何会转写音频的 OpenAI 客户端或 SDK 都能经 magpie 使用它。

```sh
magpie plugin add @magpie-community/opencode-volcengine-asr-auth
magpie plugin login volcengine-asr      # 粘贴你的 API Key
```

Key 是火山引擎控制台的 **API Key**（豆包语音 › API Key），并开通你要用的资源。magpie 把它和其他登录信息存在一起；
插件只把它发给 `openspeech.bytedance.com`，也不会出现在任何返回里。需要支持
`/v1/audio/transcriptions` 的 magpie（v0.1.1602 及以后）。

## 模型

| 模型 | 火山引擎资源 | 调用方式 | 音频 |
|---|---|---|---|
| `volcengine-asr/bigasr-flash` | `volc.bigasr.auc_turbo`（录音文件识别极速版） | 标准上传，一次请求 | 最长 2 小时、100 MB；WAV、MP3、OGG Opus |
| `volcengine-asr/seed-asr-2.0` | `volc.seedasr.auc`（录音文件识别模型 2.0） | 按 URL 的任务（见下） | 最长 5 小时、512 MB；WAV、MP3、OGG |
| `volcengine-asr/bigasr-1.0` | `volc.bigasr.auc`（录音文件识别模型 1.0） | 按 URL 的任务（见下） | 同上 |

每个资源都要在火山引擎控制台为你的 Key 开通。

## 上传文件：`bigasr-flash`

标准的 OpenAI 请求：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3425/v1", api_key="<magpie 网关 key>")
result = client.audio.transcriptions.create(
    model="volcengine-asr/bigasr-flash",
    file=open("meeting.mp3", "rb"),
    response_format="verbose_json",   # json（默认）、text 或 verbose_json
    language="zh",                    # 可选：ISO 639-1，或 zh-CN 这样的语种代码
)
print(result.text)
```

`verbose_json` 返回 `segments`，含以秒计的 `start`、`end` 和火山引擎分配的 `speaker`。
也可以不传 `file`，改传 `audio_url`（https）让火山引擎自己下载。静音音频返回空文本。

## 长音频：`seed-asr-2.0` 和 `bigasr-1.0`

这两个版本按音频 URL 以任务方式运行，可能要几分钟，超过 magpie 给一次请求的三分钟。
所以每一步都是一次单独的 `/v1/audio/transcriptions` 调用，用 multipart 表单的 `volc_operation` 指明：

| `volc_operation` | 其他字段 | 返回 |
|---|---|---|
| `submit` | `volc_task_id`（你生成的小写 UUID）、`audio_url`（https）、`audio_format`（`raw`、`wav`、`mp3`、`ogg`），可选 `language` | `{"object": "volcengine.asr.task", "task_id", "status": "submitted"}` |
| `query` | `volc_task_id` | `status` 为 `processing`、`queued`、`silent` 或 `completed`；完成时 `payload` 是火山引擎的原始结果（文本，以及带说话人、语种、情绪、性别、语速、音量的分句） |
| `readiness` | 无 | `{"object": "volcengine.asr.readiness", "ready", "provider_status", "reason"}`：火山引擎是否接受此 Key 访问该模型的资源 |

```sh
curl http://127.0.0.1:3425/v1/audio/transcriptions -H "Authorization: Bearer $KEY" \
  -F model=volcengine-asr/seed-asr-2.0 -F volc_operation=submit \
  -F volc_task_id=$(uuidgen | tr A-Z a-z) -F audio_url=https://example.com/meeting.mp3 -F audio_format=mp3
# 之后大约每秒一次，用同一个 task id 加 -F volc_operation=query
```

音频由火山引擎自己下载，不经过 magpie。发给这两个模型的上传会返回 400 并说明调用方式。

## 错误

格式不对的请求在询问火山引擎之前就返回 400。火山引擎拒绝时返回 502，错误里带它的状态码和消息
（例如无法下载音频时为 `status=45000006`）；连不上火山引擎时返回 502 `transport_error`。
`/audio/transcriptions` 以外的请求返回 404。

## 测试

```sh
node --test test.mjs
```
