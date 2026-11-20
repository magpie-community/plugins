# MuseBridge for Magpie

想让 Magpie 直接用上 muse.ai？这个插件就是缺的那块拼图。

前提只有一个：你已经跑起来了 [MuseBridge](https://github.com/DaBinBinah/muse-bridge)。
它把 muse.ai 变成一个 OpenAI 兼容接口，重活全归它干——多账号自动轮换、可视化管理
面板、工具调用（模拟）。而这个插件只做一件小事：把 Magpie 的请求转发给你的
MuseBridge，就这么简单。

> 小声说明：这是第三方社区插件，Magpie 官方没审过也没收录；MuseBridge 跟
> Meta/Muse AI 也没有任何官方关系。

## 工作方式

Magpie 的供应商插件不用起本地服务，只要提供一个自定义 `fetch` 就行。MuseBridge
本来就说 OpenAI 的"话"（Chat Completions），所以插件只干三件事：

1. 把 Magpie 网关生成的请求**原样转发**给你的 MuseBridge，顺手带上你的 API Key；
2. 从服务的 `GET /v1/models` **按账号刷新模型列表**（服务不在时就用内置目录）；
3. 上游报什么错就**原样传什么错**——401（Key 失效）、404（模型不可用）、
   429/5xx（限流/切换），Magpie 都认识，该切号切号。

服务没启动？你会收到一句人话："无法连接 MuseBridge 服务（地址）：……请确认
muse2api 已启动"。Magpie 按 5xx 处理，不会冤枉你的账号。

## 登录

在 Magpie 里选择 MuseBridge 后（或终端 `magpie plugin login musebridge`）会问两项：

| 项目 | 说明 | 默认 |
|---|---|---|
| **API Key** | `m2a-` 开头，在 MuseBridge 管理面板「API 密钥」创建；首次启动时服务也会自动生成一个，存在服务端 `data/api_key` | 必填 |
| **服务地址** | MuseBridge 服务的地址 | `http://127.0.0.1:18610` |

## 凭证保存在哪里

登录信息由 Magpie 宿主统一保管在 `~/.config/magpie/plugin-auth.json`
（权限 600）。这个插件**不落盘任何密钥**，仓库里也没有任何真实凭证；每个
Magpie 账号作用域独立，支持在同一插件下登录多个 MuseBridge 服务/Key。

MuseBridge 自己的 muse.ai Cookie 依旧只存在你的 MuseBridge 服务端
（`data/accounts.json`），插件永远接触不到。

## 模型列表

内置目录（全部路由到 muse.ai 的对话助手，`tool_call` 为模拟实现、尽力而为）：

| 模型 id | 说明 |
|---|---|
| `muse-chat` | 默认对话模型 |
| `gpt-4o` / `gpt-4o-mini` / `gpt-4.1` / `gpt-5` | 常用别名 |
| `claude-sonnet-4` / `deepseek-chat` | 其他别名 |

登录后插件会从你的 MuseBridge 服务刷新 `GET /v1/models`：服务器认识的
新别名会自动出现，图像/视频模型（`muse-image`、`muse-video`、`dall-e-3`、
`sora` 等）会被过滤掉——Magpie 的对话网关用不了它们。

## 安装

前置：先在一台机器上跑起 MuseBridge 服务（见其
[README](https://github.com/DaBinBinah/muse-bridge#readme)），面板能打开即就绪。

**方式一 · 本地目录（开发/试用）**

```bash
git clone https://github.com/DaBinBinah/muse-bridge-magpie.git
magpie plugin add ./muse-bridge-magpie
magpie plugin login musebridge   # 输入 m2a- Key 和服务地址
magpie provider test musebridge muse-chat
```

**方式二 · Magpie「插件 → 发现」页面**

仓库加了 `magpie-plugin` topic 后会出现在「非官方插件 · GitHub」列表里
（按 star 排序，标注"未审阅"），点安装即可。

**方式三 · npm（如果已发布）**

npm 包：https://www.npmjs.com/package/muse-bridge-magpie
主仓库：https://github.com/DaBinBinah/muse-bridge

```bash
magpie plugin add muse-bridge-magpie
```

## 测试

仓库自带三层检查，都可以本地跑：

```bash
npm run check        # ① node --test 纯函数单测 + ② 模拟宿主加载检查
npm run real-check   # ③ 对真实服务发一次对话（需要环境变量）
```

③ 的用法（密钥走环境变量，不会出现在任何输出里）：

```bash
MUSE2API_KEY=m2a-你的key MUSE2API_BASE=http://127.0.0.1:18610 npm run real-check
```

更完整的沙盒（隔离 HOME，不碰你真实的 Magpie 配置）：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
  MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./muse-bridge-magpie </dev/null
m plugin --json
m plugin login musebridge
m provider test musebridge muse-chat
```

## 卸载

在 Magpie 插件管理里移除 MuseBridge 即可（或参考 `magpie plugin --help`
的移除命令）。登录信息留在 `~/.config/magpie/plugin-auth.json`，介意的话
手动删掉对应条目；MuseBridge 服务与其 muse.ai Cookie 不受影响。

## 相关仓库

- 服务端（就是想让你看到的这个）：[DaBinBinah/muse-bridge](https://github.com/DaBinBinah/muse-bridge)
- 发布步骤（建仓 / topic / npm / 社区列表 PR）：见本仓库 [PUBLISH.md](PUBLISH.md)

## License

[MIT](LICENSE)
