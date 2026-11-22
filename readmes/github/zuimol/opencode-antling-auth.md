# opencode-antling-auth

**magpie / OpenCode 供应商插件：蚂蚁百灵（Ant Ling）开放平台 API。**

用自己的百灵 API Key 接入 OpenAI 兼容端点，magpie / OpenCode 直接可用。

```bash
# magpie 安装插件
magpie plugin add opencode-antling-auth

# OpenCode 安装
opencode auth login   # 选择 antling，粘贴 API Key
```

## 平台信息

| 项目 | 值 |
|---|---|
| 控制台 | https://chat.ant-ling.com/platform/api |
| API 端点 | `https://api.ant-ling.com/v1` |
| 协议 | OpenAI 兼容（`/v1/chat/completions`、`/v1/models`） |
| 鉴权 | `Authorization: Bearer <API Key>` |

## 获取 API Key

1. 打开 https://chat.ant-ling.com/platform/api
2. 进入「密钥管理」创建 / 复制 API Key
3. `magpie plugin login antling`（或 OpenCode 的 `auth login`）时粘贴

authorize 阶段会用 `/v1/models`（只读、不消耗余额）真实校验 key。

## 模型清单

config 里给的是 Ling 系列初始占位目录。装好并登录后运行：

```bash
magpie provider models antling
```

magpie 会从上游 `/v1/models` 拉取真实模型目录并缓存。

## 自定义接入地址

默认 `https://api.ant-ling.com/v1`。如需覆盖：

- magpie 里改 provider 的 `baseUrl` 选项，或
- 环境变量 `ANT_LING_BASE_URL`

## License

MIT