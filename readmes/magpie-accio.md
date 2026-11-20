# magpie-accio

把 **Accio（阿里 Accio Work，中国版）** 的模型接进 **magpie**：网页登录一次就能用，不必装 Accio 桌面客户端。

- **登录** —— Accio 网页 OAuth（PKCE + `127.0.0.1` 回环回调），凭据写进 magpie 的插件槽，过期自动续。
- **对话** —— magpie 给的是 OpenAI 线格式，插件翻成 Gemini 信封发往 `phoenix-gw.alibaba.com`，流式回包再反译成 OpenAI SSE。
- **落地形态** —— 一个 OpenCode v1 server 插件（`config` / `auth` / `provider` 三个钩子），纯 HTTP，无原生模块。

## 它能做什么

- **网页登录**：授权在浏览器里完成，插件只起一个本机回调端口。
- **实时模型目录**：按账号权益拉取，名字直接带积分倍率。
- **完整对话**：流式、工具调用、思维链单独成 `reasoning_content`、图片输入。
- **自动续期**：`refresh_token` 一次性轮换，按账号单飞，避免并发把账号标死。
- **额度卡片**：每日 / 推荐积分的占用与剩余、每日刷新倒计时（只读）。
- **可选本地反代**：`127.0.0.1` 上的 OpenAI 兼容端点。

> 非官方插件，只做中国版（`www.accio-ai.com`）。计费走你自己的 Accio 账号。

## 安装

```sh
# 从 npm
magpie plugin add magpie-accio

# 或本地源码
magpie plugin add "<本目录的绝对路径>"
```

装完重启 magpie，供应商列表里出现 **Accio（阿里）**。

## 登录

1. 供应商卡片点 **登录 Accio（阿里）**。
2. magpie 用**系统默认浏览器**打开 Accio 登录页（插件只起本地回调服务，不自己开窗口）。
3. 正常登录（手机号 / 邮箱 / 扫码皆可）。回调页显示「授权已收到」即完成。
4. 模型选择器里出现 `accio/…`，卡片显示账号名与额度。

## 模型

目录来自 `POST /api/llm/config/v2`，逐条筛选：

| 规则 | 说明 |
| --- | --- |
| `visible === true` | 服务端没下发的不要 |
| `locked` 为空 | 套餐不够、用不了的（客户端里显示「已锁定」）不拉取 |
| 有 `modelCode` | 空 id 会让整个目录不可用 |
| 名字带倍率 | `effectiveMultiple` → `Qwen 3.8 Flash · x0.003`；没有倍率就不加后缀 |

倍率是该模型每 token 花的积分倍数，挑模型直接看这个数。中国区账号实测 16 个：
Qwen 3.8 / 4 Max 系、GLM 5.x、DeepSeek V4 系、Kimi K2.6、MiniMax M3、Standard / Professional / Ultimate。

给 **DeepSeek Harness** 用：magpie → Agents 页把 DSH 指向 magpie 网关，模型选 `accio/<模型>`，DSH 侧不装东西。

## 可选：本地反代

```json
{ "relay": { "port": 47821, "token": "" } }
```

```sh
curl http://127.0.0.1:47821/v1/models
curl http://127.0.0.1:47821/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

只绑回环；配了 `relay.token` 就要求 `Authorization: Bearer <token>`。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `relay.port` / `relay.host` / `relay.token` | 不开 | 本地 OpenAI 兼容反代 |
| `proxy` | 跟随宿主 | 不写就用 magpie 注入的 `HTTPS_PROXY`；写了就用它 |

## 目录结构

```
index.mjs        插件入口：config / auth / provider 钩子
src/accio.mjs    协议层：PKCE 登录、目录、OpenAI⇄Gemini 信封、SSE 翻译、额度
src/icon.mjs     图标：随包 PNG → data:image/png URI
src/relay.mjs    可选：本地 OpenAI 兼容反代
icons/           accio-48/128/256.png + 官方 SVG
publish/         推 GitHub / 发 npm / 提 registry PR 的脚本
test/run.mjs     离线自测（不联网）
```

## 协议要点

1. **token 放请求体 `body.token`**，放 `Authorization` 头会稳定拿到流内 402。
2. **上行 `model` 必须是 `modelCode`**（`1Drift-…`），展示名只是对外 id，发展示名就是「模型不回复」。
3. **`HTTP 200` + `text/html`** 是风控拦截页，不是回复 —— 必须校验 content-type。
4. **工具结果**用 `role:user + functionResponse`，且紧挨着上一批 `functionCall`，中间插消息会断开配对。
5. **`refresh_token` 一次性轮换**：续期按账号单飞；`403 + HTML` 不续期（风控），`401/403 + JSON` 才续一次。

## 已知限制

- **只做中国版**：登录页固定 `www.accio-ai.com`。
- **非官方**：Accio 没有公开的第三方接入文档，接口按 2026-11 实测口径实现。
- **计费在 Accio 侧**：对话消耗账号积分；拉目录 / 查额度 / 续期不消耗。
- **思考关不掉**：上游没有受控字段关 reasoning，档位只做展示。
- **图片只收 base64 data URL**：远程图片链接会被明确拒绝。

## 与 magpie 宿主的两条硬规矩

| 现象 | 做法 |
| --- | --- |
| 登录报「the sign-in failed」「gave nothing to keep」 | `callback()` 返回 `{type:'success', access, refresh, expires, …}` |
| 账号到点不续期 | 自己写槽用 `{type:'oauth', …}`，旧槽在 `models()`/`loader()` 里升级 |

原因：宿主 `signingIn()` 要求 `r.type === 'success'`，`keptAs()` 要求带 `refresh`/`access`，
而 `renewAt()` 只对 `stored.type === 'oauth'` 生效。

## 排障

| 症状 | 先看这里 |
| --- | --- |
| 选择器空了 | 插件没加载（`magpie plugin list`）或没登录；日志找 `magpie-accio:` |
| 聊天 401 | 登录态失效，重新登录 |
| 卡片没有「每月积分」 | 正常：免费账号没有这个桶 |
| 回复永远是空的 | 多半风控，插件会明确报「上游没有返回事件流」 |
| 登录页提示「请升级客户端」 | 授权 URL 缺 `code_challenge`（插件已带，别删） |

## 自测

```sh
node test/run.mjs
# 或 magpie 自带的 bun
"C:\Users\<你>\.cache\magpie\bun\1.4.2\magpie-bun.exe" test/run.mjs
```

覆盖：信封解析、秒→毫秒、目录归一（locked 不拉取 / 倍率后缀）、slug↔modelCode、工具结果配对、
请求体形状、SSE→OpenAI chunk（思维链 / 分片工具调用 / 用量）、401 硬续期、「200+HTML = 风控页」、
反代端点与 token 校验、宿主登录态的两道门。

## 许可

MIT
