# magpie-intern-ai

书生端砚（[InternAI Discovery](https://discovery.intern-ai.org.cn)）的 [Magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) 供应商插件。用你自己的书生端砚 API key，把它的模型接入 Magpie / OpenCode。

- **单一供应商、一次登录**：只显示一个"书生端砚"，模型列表里自动处理协议分流
- **协议自动分流**：普通模型走 OpenAI 兼容协议；id 含 `claude` 的模型自动分流到 Anthropic / SystemOne 原生协议（同域），保留 server-side cache 等 Anthropic 特性
- **多账号**：每个账号独立登录、独立配置，互不干扰
- **模型列表动态获取**：登录后从 `/v1/models` 拉取账号实际可用的模型，不写死任何静态列表
- **零运行时依赖**

## 供应商

| id | 默认协议 | 默认 Base URL | AI SDK |
| --- | --- | --- | --- |
| `duanyan` | OpenAI 兼容（chat completions） | `https://discovery-api.intern-ai.org.cn/v1` | `@ai-sdk/openai-compatible` |

claude 系模型在动态列表里自动挂 `@ai-sdk/anthropic` + `https://discovery-api.intern-ai.org.cn`（模型级 `api` 覆盖，社区 Zed 插件同款机制），对宿主仍只显示一个供应商。

> 注：如果供应商 id 在你的 Magpie 版本里与内置订阅冲突，宿主会自动改名为 `duanyan-plugin`，属于正常行为。

## 获取 API key

1. 打开 [discovery.intern-ai.org.cn](https://discovery.intern-ai.org.cn)，注册 / 登录你的账号。
2. 在控制台（API 管理）里生成 API key。
3. 复制 key，登录时粘贴。

## 安装

### Magpie

```bash
# 从 GitHub 直接安装
magpie plugin add github:ca-x/magpie-intern-ai

# 或从 npm
magpie plugin add magpie-intern-ai
```

安装后登录（一次即可）：

```bash
magpie plugin login duanyan
```

验证：

```bash
magpie plugin --json        # 无加载错误
magpie provider test duanyan
```

### OpenCode

```bash
opencode plugin add ca-x/magpie-intern-ai
```

OpenCode 会忽略 Magpie 专属行为，登录方式与供应商配置照常可用。

### 应用内安装

Magpie → 设置 → 插件 → 发现/安装，粘贴本仓库地址或 npm 包名 `magpie-intern-ai`，然后在供应商页面添加账号。

## 多账号

在供应商设置里多次添加账号即可（或多次执行 `magpie plugin login duanyan`）。策略说明：

- **隔离**：每个账号存自己的 API key，模型列表按账号各自拉取（谁的 key 拉谁的可用模型），账号间状态完全隔离；宿主负责账号调度（`id#xxxxxx` 存储、按账号排队/切换）。
- **命名**：登录时可填"账号备注名"（存 `metadata.email`，宿主用它显示账号名）；不填则用 key 尾几位区分。同备注名再次登录会替换原账号。
- **并发**：默认每账号同时 4 个请求（`maxConcurrency`），防止触发平台限流；可在供应商设置里调整。

## 模型列表说明

- 登录后插件调用 `GET https://discovery-api.intern-ai.org.cn/v1/models`（带该账号的 key）获取实际可用模型，**没有静态兜底列表**，模型完全以动态获取为准。
- 全部模型列在同一个供应商下：id 含 `claude` 的自动分流到 Anthropic 原生协议端点，其余走 OpenAI 兼容端点。
- 能力/价格平台清单不提供，插件给中性默认（支持 tool call、价格 0），宿主里可自行覆盖。
- 拉取失败（网络/平台问题）时保留宿主已有的模型配置；key 失效（401/403）时提示重新登录。

## 开发与测试

本地单元测试（不需要网络，模拟宿主调用各钩子）：

```bash
npm test   # node --test test/*.test.mjs，push 时 CI 也会跑
```

沙箱集成测试（绝不在日常使用的 magpie 上测）：

```bash
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" magpie "$@"; }

m plugin add ./magpie-intern-ai    # 文件夹就地加载
m plugin --json                    # 检查加载错误
m plugin login duanyan             # 粘贴 API key
m provider test duanyan            # 每种 API 发一个小请求
```

## 隐私

插件只把你的对话请求转发到书生端砚官方 API（`discovery-api.intern-ai.org.cn`），不记录、不上报任何内容。

## License

MIT
