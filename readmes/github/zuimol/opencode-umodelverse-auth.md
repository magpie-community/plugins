# opencode-umodelverse-auth

**magpie / OpenCode 供应商插件：UCloud UModelVerse（星图 · 模型服务平台）。**

用自己的 UModelVerse API Key 接入 OpenAI 兼容端点，magpie / OpenCode 直接可用。

```bash
# magpie 安装插件
magpie plugin add opencode-umodelverse-auth

# OpenCode 安装
opencode auth login   # 选择 umodelverse，粘贴 API Key
```

## 平台信息

| 项目 | 值 |
|---|---|
| 控制台 | https://astraflow.ucloud.cn |
| 文档 | https://astraflow.ucloud.cn/docs （模型服务 → 快速开始） |
| 大陆统一接入 | `https://api.modelverse.cn/v1`（默认） |
| 海外统一接入 | `https://api.umodelversa.ai/v1`（用 `UMODELVERSE_BASE_URL` 覆盖） |
| 协议 | OpenAI 兼容（`/v1/chat/completions`、`/v1/responses`、`/v1/models`） |
| 鉴权 | `Authorization: Bearer <API Key>` |

## 获取 API Key

1. 打开 https://astraflow.ucloud.cn → 认证鉴权 → 创建 API 密钥
2. `magpie plugin login umodelverse`（或 OpenCode 的 `auth login`）时粘贴

## 模型清单

内置 28 个聊天类主流型号（GLM-5.3 系、DeepSeek-V4.1 系、Qwen3.8 系、Kimi K3.1、
MiniMax M3/H3、MiMo v2.6、豆包 Seed 2.1、百灵 LingDT-3.0、腾讯 Hy4）。
全量目录（含图像/视频/TTS）公开可查，运行：

```bash
magpie provider models umodelverse
```

magpie 会从上游 `/v1/models` 拉取并缓存。内置清单里 `limit.context` 为保守占位，
拉取真实目录后以缓存值为准。

## 验证

```bash
magpie provider test umodelverse
```

`/v1/models` 是公开只读端点，authorize 只确认端点可达；key 的有效性由
首次真实调用确认。

## License

MIT