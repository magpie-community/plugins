# Incognito

**@magpie-community/middleware-incognito** — 让任何 AI agent 在模型上游面前隐身。
One magpie gateway middleware, every agent, zero config.

> English TL;DR: some model upstreams fingerprint AI-agent identity sentences
> and reject them in disguise (fake `400 Cannot find model`, endless queues).
> Incognito neutralizes identity declarations with pure-punctuation rewrites
> (meaning preserved), rewrites known poison sentences, and strips `[1M]`
> model-name markers — on all three gateway paths, for every agent, with no
> per-agent configuration.

## 为什么需要它

某些模型上游会对「你用的是哪个 agent」做指纹级识别,而且拒绝得很有迷惑性。两个真实案例(均已完成全链路取证):

| 客户端带的话 | 上游反应 | 真实原因 |
| --- | --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | 请求被扔进永远排不到的慢队列(表现为挂死 1~6 分钟) | dsh 每个请求必带此句 → 必挂 |
| `You are Claude Code, Anthropic's official CLI for Claude.` | 伪装成 `400 Cannot find model` | claude code 交互模式身份句必带 → 必挂;`-p`/SDK 模式用另一句身份声明,所以幸免 |

裸词、词组都无害(一个通过了的请求体里有 10 处裸 `Claude Code`),**只有整句身份声明命中**。而新 agent 层出不穷,逐个字符串打地鼠永远打不完——所以 Incognito 打的是**形状**。

## 它做什么(三个机制)

1. **身份句形状免疫**(核心,零语义损失):把 system 提示里的身份句做纯标点改写——
   - `You are <Name>, <描述>.` → `You are <Name> (<描述>).`
   - `You are ... powered by <品牌>.` → `You are ... (powered by <品牌>).`

   上游的精确匹配指纹全部失效,模型读到的是同一个意思。只动每个文本块的**第一处**身份句;实测逗号→括号这一个字符的改动就能让指纹命中变 200。
2. **已知毒句精确改写**(双保险):内置规则表深扫请求里**所有**字符串——messages、system、instructions、input、tools,连用户输入都扫。可在插件选项里追加自己的规则,不用改文件。
3. **模型名规范化**:剥掉 `body.model` 结尾的 `[1M]`/`[1m]` 上下文标记(Claude Code 的习惯),上游就不会报 `unknown or disabled model "fast[1M]"`。

三条网关路径全覆盖:`/v1/chat/completions`(OpenAI)、`/v1/messages`(Anthropic)、`/v1/responses`(Responses)——onRequest 钩子在三条路径上都会触发。

## 安装

```sh
magpie plugin add @magpie-community/middleware-incognito
```

装完重启 magpie app 即生效。之后**任何**接入网关的 agent(dsh、Claude Code、Codex、Hermes、pi、OpenCode……)自动被保护,零逐个配置。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `harden_identity` | `true` | 身份句形状免疫;设 `false` 关闭 |
| `strip_model_suffix` | `true` | 剥模型名结尾 `[1M]`/`[1m]` |
| `rules` | `[]` | 追加精确规则,`{"from": "毒句", "to": "安全句"}` 数组,与内置规则合并 |

## 自检方法

怀疑某个请求被上游指纹拒绝时:`400 Cannot find model`、莫名排队假死,先做**原体回放**——把请求体原样用 curl 重发到网关,当下复现 = 毒在请求内容里;再对 body 逐字段二分(system/messages/tools/stream…)定位毒句,最后在选项 `rules` 里加一条精确规则。规则不命中的请求字节级原样放行,Incognito 对无辜流量零影响。

## 已知边界

形状免疫覆盖的是「身份声明句」类别。若上游将来打击其它类别(比如非身份位置的纯品牌词组整句),需按上述自检方法定位后在 `rules` 里加精确规则。

## License

MIT
