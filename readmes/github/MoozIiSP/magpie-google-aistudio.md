# Google AI Studio for Magpie

一个使用 Google AI Studio API Key 的 [Magpie](https://github.com/yetone/magpie) provider 插件，provider ID 为 `google-aistudio`。它获取账号可见的 Google 模型目录，并将部分接口适配到 Magpie 网关。

**项目处于早期阶段。** 对话和文本 embedding 已实际调用；TTS 和图像接口目前只验证了模拟转发，视频、音乐和实时接口尚未适配。本项目与 Google 和 Magpie 官方无关联。

## 安装

```bash
magpie plugin add github:MoozIiSP/magpie-google-aistudio
magpie plugin login google-aistudio
```

也可以在 Magpie 的 Plugins 页面使用 `github:MoozIiSP/magpie-google-aistudio` 安装，然后在提供商页面输入 API Key。Magpie 管理密钥；不要将密钥写进插件文件或仓库。模型目录通过 Google `v1beta/models` 分页动态获取，以该 Key 可见的实际结果为准；每个模型显示为 `google-aistudio/<模型ID>`。

插件仅支持 API Key。Magpie 将插件凭据统一作为账号处理，添加按钮仍可能显示“添加账号”；插件不能改写宿主按钮。为了让提供商状态显示脱敏密钥，插件将密钥的前四位和后四位写入 Magpie 提供的用量 `plan` 展示字段；这只是密钥标识，并不表示订阅套餐或额度。

Magpie 对插件提供商在未手动选择时可能只展示部分模型；其余模型可在提供商设置中手动勾选。模型可能被 Google 列出但当前账号没有调用权限。

## 模型分类和支持范围

列表中的 `[对话]`、`[向量]`、`[语音合成]`、`[语音转录]`、`[图像]`、`[视频]`、`[音乐]`、`[实时音视频]` 和 `[其他]` 是插件根据 Google 返回的支持方法及模型 ID 推断的用途标签；它们不是 Magpie 原生的用途分类，Google 目录也不保证提供完整能力元数据。新名称或未知模型会被保留并标为其他，不保证自动判断准确。

Magpie 当前会把明确声明为非聊天输出的插件模型从常用目录中移除，因此这里保留用途前缀，让对应模型仍有机会被选择；不要把非聊天模型选作聊天模型。插件会拒绝已知的向量、语音、视频、音乐和实时音视频模型的聊天请求。

| 用途 | 插件目前支持 |
| --- | --- |
| 对话 | 通过 Google OpenAI 兼容 `chat/completions` 转发，包括流式结果；实际模态、工具和模型支持由 Google 决定。 |
| 向量 | 通过 Google OpenAI 兼容 `embeddings` 转发文本和上游接受的参数。多模态 embedding 尚未验证。 |
| TTS | 通过 Gemini `generateContent` 转换到非流式 WAV / PCM。 |
| 图像 | 转发 Google OpenAI 兼容 `images/generations`；并非所有图像模型都支持该接口。 |
| 语音转录、视频、音乐、实时音视频及其他 | 可以发现并标记，但对应专用 API 暂未适配；不能因为出现在列表就认为可调用。 |

不能承诺 Google 所有模型和专用接口都可通过 Magpie 使用；模型的权限、配额和功能还取决于 Google 与网关支持。

## 请求示例

本机示例的 `magpie` 是本地网关令牌，不是 Google API Key。网络共享时使用 Magpie 设置的网关密钥及可访问地址。

```bash
curl -sS http://127.0.0.1:3425/v1/embeddings \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"google-aistudio/gemini-embedding-2","input":"你好，世界"}'
```

```bash
curl -sS http://127.0.0.1:3425/v1/audio/speech \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"google-aistudio/gemini-2.5-flash-preview-tts","input":"你好，世界","voice":"Kore","response_format":"wav"}' \
  -o speech.wav
```

TTS 需要 Magpie 网关支持 `/v1/audio/speech` 且账号有相应模型权限。需显式指定 `wav` 或 `pcm`；不支持 mp3、流式输出、自定义 instructions 或非 1 的 speed。可填写 Google 预置音色；部分 OpenAI 音色名会映射到 Google 音色。真实 Google TTS 请求尚未验证。

从本地目录开发时，修改后需在 Magpie 的 Plugins 页面将插件关闭再开启，使运行中的插件宿主重新加载；老网关若对 TTS 返回 404，还需要重启 Magpie，这会暂时中断网关请求。

## 测试

```bash
npm test
```

测试使用模拟 Google 响应，不需要真实 API Key。

## 许可证

[MIT](LICENSE)。
