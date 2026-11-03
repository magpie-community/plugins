# key-cabinet · Magpie page plugin

Key Cabinet adds the multi-key management Magpie leaves out: one gateway key per project, issued, revealed, rotated and deleted from the page, plus Magpie limits and usage per key. It reuses Magpie's own gateway and CLI — no extra router, protocol or relay. The page is served by a small local service on `127.0.0.1:3491` that only its own page can use; issued secrets stay in `~/.config/magpie/page-project-keys/projects.json`.

一把钥匙一个调用方：页内签发 / 查看 / 重置 / 删除网关 Key，模型选 Auto 或指定已有 `group/…` / 单模型，用量按 caller key 汇总。

**只补 Magpie 缺的多 Key 管理**——不自建路由、协议或网关。同一把 Key 可走 Magpie 全部协议，接入任意 Agent。

**本机访问限制：** Magpie 默认信任从本机回环地址发出的请求，即使没有 Key，或使用了已停用、删除、重置的旧 Key，也可能继续访问网关。钥匙柜无法改变这一上游行为；不要将这些操作当作阻止本机程序访问网关的安全边界。参见 [Magpie 的说明](https://github.com/yetone/magpie/issues/3375)。

## 安装

```bash
magpie plugin add @magpie-community/page-key-cabinet
```

或在 Magpie › Plugins › Discover › Pages 里安装。

> 中文页签用 `magpie.page.titles.zh`＝钥匙柜。本地开发时也可以 `magpie plugin add ./key-cabinet` 指向源码目录。

服务默认监听 `127.0.0.1:3491`（`magpie.page.service`）；宿主提供自定义端口时也会在该端口启动服务。

## 能力

| 动作 | 实现 |
|---|---|
| 新钥匙 | `magpie gateway-key add project:<标识>`（Magpie 自造 `sk-magpie-key-…` 并打印；插件接住明文） |
| 查看 / 复制 | 明文缓存在插件本地映射；签发与重置时完整展示 |
| 重置 | `gateway-key rotate`（Magpie 再打印新 secret） |
| 删除 | `gateway-key remove` + 去掉本地映射 |
| 模型 | Magpie `/v1/models`（含路由组）；空 = Auto；指定则 `gateway-key models` |
| 限额 | 页内编辑：窗口（每天/每周/每月/自定义 N 天或 N 小时）+ Tokens / 费用上限，可选「缓存读取也计入 Tokens」；保存先删掉附加限额、保留主限额，再写目标窗口（任一步失败只会更严格，不会短暂变成无限额）；随后回读确认窗口/上限/缓存计入；展示随 `gateway-key list` 读取真实用量，读不到时显示「—」 |
| 用量 | `magpie usage --csv` 按 `caller_key_id` / `caller_key_name` 汇总（短缓存，首屏不阻塞）。Tokens 口径与 Magpie 一致：input + output；cache read/write 单列展示。趋势 = 当前窗口对比上一个等长窗口（今天对比昨天，7d/30d 对比上一个 7/30 天），all 不显示 |

Key 命名约定：`project:<标识>`（底层仍用 Magpie caller key；页内叫「钥匙」）。

本地数据：`~/.config/magpie/page-project-keys/projects.json`（含签发/重置时 Magpie 打印的 secret，便于「查看」）。保存时先 fsync 再以 `0600` 权限原子替换；写入前会获取同目录的 `projects.json.lock`，多个插件进程并发修改也不会互相覆盖（锁里带持有者 token，只由持有者释放；死进程的锁按 pid 清理，活进程的锁不会因为耗时久被强拆）。

服务启动时还会写 `server-<端口>.json` 实例指纹（nonce + pid）；端口被占时只复用指纹匹配的实例，自称同名 service 的其它进程不会被当作自己人。API 请求体上限 1 MiB，健康检查同样带 nonce、不含本地路径。

状态以 Magpie 为准：页内状态按钮和「停用」提示只在**非本机**调用上生效；Magpie GUI 改过状态后，页内会按 Magpie 当前值显示，并提示与本地记录不一致。回到页面（窗口重新获得焦点）时会静默同步一次 Magpie 状态，没有变化就不重绘。

限额编辑分工：写入走 `magpie gateway-key limit`（Magpie 负责校验与执行），编辑器回填只读 `caller-keys.json` 的 `limit` / `moreLimits`。保存后会回读一次确认；旧版插件进程不支持 `/limits` 时会明确提示「无法确认」，不会假装成功。

Magpie 侧被删除或轮换的 Key：页内「查看」会提示「Magpie 中已找不到这把 Key」；列表还会用 Magpie 掩码的后 6 位核对本地明文，对不上时提示「本地明文已过期，请重置」（回到页面同步时也会检查）。「删除」照样能清掉本地记录（不会卡死），「重置」会提示先删除后重新签发。

注意：不能把自造的 `sk-magpie-key-…` 经 `--key` 塞回 Magpie——该前缀只能由 Magpie 签发。项目修改在进程内串行，并额外跨进程加锁。

## 界面语言

页面跟随 Magpie 的窗口语言：`magpie.theme.lang` 由 `page/boot.js` 带成 `?lang=`，中文环境显示中文，其它语言显示英文。不经 Magpie、直接打开 `127.0.0.1:3491` 时回退到浏览器 `navigator.language`。

翻译覆盖页签标题、列表、详情抽屉、提示/确认、服务端错误和复制的配置模板注释；钥匙名、`project:` 标识、模型名与密钥等用户数据保持原样。等本地服务超时、SSH 端口转发提示这类桥接页文案也会跟随 Magpie 语言。

## 接到任意 Agent（同一 Key · 全协议）

一把钥匙 = Magpie Gateway 的 caller key。客户端填 **Base URL + Key**，用量会记到这把钥匙。

### OpenAI Chat Completions（Pi / OpenCode / Continue / 多数 Agent）

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3425/v1
export OPENAI_API_KEY='sk-magpie-key-…'   # key-cabinet「复制 Key」
# 可选：export OPENAI_MODEL=group/never-stuck
```

### OpenAI Responses（Codex 等）

与上面同一组 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，客户端走 `POST /v1/responses`。

### Anthropic / Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3425
export ANTHROPIC_API_KEY='sk-magpie-key-…'
export ANTHROPIC_AUTH_TOKEN='sk-magpie-key-…'  # Claude Code 读这个
```

### Gemini

```bash
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3425
export GEMINI_API_KEY='sk-magpie-key-…'
```

页内钥匙详情可切换 OpenAI / Responses / Anthropic / Gemini，一键复制环境变量。

## 开发

```bash
node ./serve.mjs          # 起服务（Magpie 里由插件宿主调用同一个 server()）
open http://127.0.0.1:3491
node --test test/*.test.mjs
bun test                  # 社区仓库 CI 用的命令
node ./test/qa-smoke.mjs  # 会创建和删除真实 Magpie Key，并使用已有 Key 请求网关
```

`qa-smoke.mjs` 会修改真实 Magpie 数据，且异常中断时临时 Key 可能残留；日常回归优先使用隔离的 `npm test`。它的协议探测只请求模型列表，不能证明实际推理可用。

环境变量（可选）：

- `MAGPIE_BIN` — magpie 可执行文件
- `MAGPIE_PROJECT_KEYS_PORT` — 服务端口
- `MAGPIE_PROJECT_KEYS_GATEWAY` / `MAGPIE_ADDR` — Gateway 探测
- `MAGPIE_API_KEY` — 拉 `/v1/models` 时如需鉴权
