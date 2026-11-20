# MuseBridge for Magpie

<p>
  <a href="https://www.npmjs.com/package/muse-bridge-magpie"><img src="https://img.shields.io/npm/v/muse-bridge-magpie?logo=npm&color=cb3837" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/muse-bridge-magpie"><img src="https://img.shields.io/npm/dm/muse-bridge-magpie?color=cb3837" alt="npm 下载量"></a>
  <a href="https://github.com/DaBinBinah/muse-bridge-magpie"><img src="https://img.shields.io/badge/GitHub-muse--bridge--magpie-181717?logo=github" alt="GitHub 仓库"></a>
  <a href="https://github.com/DaBinBinah/muse-bridge"><img src="https://img.shields.io/badge/服务端-muse--bridge-2563EB?logo=github" alt="MuseBridge 服务端"></a>
</p>

在 [Magpie](https://usemagpie.ai)（兼容 OpenCode 插件）里通过你自己的
[MuseBridge](https://github.com/DaBinBinah/muse-bridge) 反代使用 muse.ai：
多账号轮换、可视化管理面板、（模拟）工具调用，全部由你的 MuseBridge 服务负责，
这个插件只负责把 Magpie 的请求转发过去。

> 说明：这是一个第三方社区插件，**未经 Magpie 官方审核或收录**。MuseBridge
> 与 Meta/Muse AI 亦无官方关系。

## 工作方式

Magpie 的供应商插件不起本地服务，而是提供一个自定义 `fetch`。MuseBridge
本来就是 OpenAI 兼容接口，所以这个插件只做三件事：

1. 把 Magpie 网关生成的 Chat Completions 请求**原样转发**到你指定的
   MuseBridge 服务，并附上你的 API Key；
2. 从服务的 `GET /v1/models` **按账号刷新模型列表**（失败时回退内置目录）；
3. 上游错误码**原样透传**——401（Key 无效）、404（模型不可用）、
   429/5xx（限流/切换）都按 Magpie 的约定被正确理解。

服务没启动时返回一个可读的 502（"无法连接 MuseBridge 服务…"），Magpie 会
按 5xx 处理，不会误标你的账号。

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

[![npm](https://img.shields.io/npm/v/muse-bridge-magpie?logo=npm&color=cb3837)](https://www.npmjs.com/package/muse-bridge-magpie)
[![GitHub](https://img.shields.io/badge/GitHub-muse--bridge--magpie-181717?logo=github)](https://github.com/DaBinBinah/muse-bridge-magpie)

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

- 服务端：[DaBinBinah/muse-bridge](https://github.com/DaBinBinah/muse-bridge)
- 发布步骤（建仓 / topic / npm / 社区列表 PR）：见本仓库 [PUBLISH.md](PUBLISH.md)

## License

[MIT](LICENSE)
