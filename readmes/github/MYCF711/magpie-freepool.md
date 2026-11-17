# 免费池 FreePool

**一张卡，15 家有免费额度的渠道。** 所有 key 一次粘贴配齐（LLM7 连 key 都不用），
模型列表里直接选 —— `llm7/…`、`groq/…`、`xkiro/…` 这样带前缀，每个前缀打的是它自己的上游。

```
magpie plugin add github:MYCF711/magpie-freepool
```

## 它给你什么

- **1 个供应商、15 个上游**：不用装 15 个插件、也不用点 15 次登录。provider id 是新的 `freepool`，
  不会和 magpie 内置的 `mistral` / `groq` / `google` 之类撞 id；即使同一个上游被两条路引用，
  两边的 key 也是各存各的。
- **一次粘贴配齐**：登录时贴一行 `groq=gsk_…;openrouter=sk-or-…;cloudflare=账号ID:token` 就行，
  没钱/没账号的那几家留空即可。也收 JSON。
- **按前缀分流**：请求里的 `model` 决定去哪个上游、用哪把 key；发出去之前会把前缀去掉。
- **一家挂了不影响别家**：目录逐家收，一家 401 只是这家不进列表；全挂才退回上次快照，再退回 seed，绝不显示 0 个模型。
- **额度只说知道的**：只有 xKiro 有 `/usage`，卡片就显示它；其余渠道不画 100% 的假进度条。

## 15 家渠道

| 渠道 | 前缀 | key | 免费额度 |
| --- | --- | --- | --- |
| [LLM7](https://token.llm7.io/) | `llm7/` | **不要** | 免费池，匿名也能用 |
| [NaraRoute](https://router.bynara.id/) | `nararoute/` | 要 | 免费池（对话层要 key） |
| [xKiro](https://xkiro.com/) | `xkiro/` | 要 | 账户自带免费 token 窗口（卡片可读） |
| [SambaNova](https://cloud.sambanova.ai/apis) | `sambanova/` | 要 | 免费试用额度 |
| [Cohere](https://dashboard.cohere.com/api-keys) | `cohere/` | 要 | Trial 限速额度 |
| [Hugging Face](https://huggingface.co/settings/tokens) | `huggingface/` | 要 | 每月少量推理额度 |
| [Cloudflare Workers AI](https://dash.cloudflare.com/profile/api-tokens) | `cloudflare/` | 要（`账号ID:token`） | 每天 10k Neurons |
| [Mistral](https://console.mistral.ai/) | `mistral/` | 要 | Experiment 免费层 |
| [Groq](https://console.groq.com/keys) | `groq/` | 要 | 每模型每日上限 |
| [Gemini](https://aistudio.google.com/apikey) | `gemini/` | 要 | AI Studio 免费层 |
| [OpenRouter](https://openrouter.ai/keys) | `openrouter/` | 要 | `:free` 模型（日限额） |
| [Kilo](https://kilo.ai) | `kilo/` | 要 | `kilo-auto/free` 档 |
| [OpenCode Zen](https://opencode.ai/auth) | `opencode-zen/` | 要 | Zen 免费模型 |
| [Ollama Cloud](https://ollama.com/settings/keys) | `ollama-cloud/` | 要 | Free 计划起始额度 |
| [NVIDIA NIM](https://build.nvidia.com/settings/api-keys) | `nvidia/` | 要 | build.nvidia.com 免费额度 |

后 8 家 magpie 也有内置预设（`magpie provider add <preset> <key>`）。两条路可以并存：
预设是「一家一张卡」，这里是「15 家一张卡 + 一次粘贴」。哪种顺手用哪种，key 不互通、互不覆盖。

## 一次粘贴长什么样

```
llm7=sk-optional;groq=gsk_xxx;openrouter=sk-or-yyy;cloudflare=abc123def:cf_token
```

- 别名认得出：`hf`→Hugging Face、`google`→Gemini、`ollama`→Ollama Cloud、`zen`/`opencode`→OpenCode Zen、`nvidia-nim`/`nim`→NVIDIA NIM。
- 认不出的名字不会被静默吞掉：卡片会显示「配了哪几家」，对不上就是没配。
- 单个裸值（不带 `=`）按 LLM7 的 key 处理 —— 那家免 key，随手贴个占位符也不会报错。

## 模型 id 怎么用

```
llm7/DeepSeek-V4-Flash-0731
groq/llama-3.3-70b-versatile
xkiro/google/gemini-3.6-flash          ← 上游 id 里的斜杠原样保留，只去掉第一段前缀
cloudflare/@cf/moonshotai/kimi-k2.6
```

发出去之前插件会把前缀切掉，上游收到的是它自己认的 id。
前缀认不出来 → 回 404 `model_not_found`，只搁置这一个模型，不动账号。

## 已知网络限制（实测 2026-11-17，本机）

- **Cohere**：`api.cohere.ai` 从部分出口被边缘层直接回 `403 Forbidden`（HTML，不是 JSON）。换 key 没用，先确认网络。
- **Hugging Face**：`router.huggingface.co` 在部分网络下连不上（超时）。
- **Gemini / Mistral**：本机实测连不上（`000`），换网络再试。

连不上的渠道不会出现在模型列表里，也不影响其他家 —— 这是「逐家收结果」的直接效果。

## 安装与验证

```bash
magpie plugin add github:MYCF711/magpie-freepool
magpie plugin list                     # 一行 provider：freepool（15 个 seed 模型）
magpie plugin login freepool           # 贴那一行 key（没有就先留空，LLM7 立刻可用）
magpie models                          # 看到 llm7/… groq/… 等
magpie plugin rm magpie-freepool       # 取消
```

从仓库目录直接装（开发时）：`magpie plugin add /path/to/magpie-freepool`

## 参考源

实现是重写，不是复制。事实来源与工程底座逐条列在 [`NOTICE.md`](./NOTICE.md)：

- [Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code)（AGPL-3.0-only）—— 各家端点与字段语义，**只取事实**。
- [cheaper-inference/OmniRoute](https://github.com/cheaper-inference/OmniRoute)（MIT）—— 免费额度口径。
- [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT）—— `src/` 与 `scripts/` 底座。

## 许可

**AGPL-3.0-only**（Copyright (c) 2026 MYCF711）。正文见 [`LICENSE`](./LICENSE)，归属见 [`NOTICE.md`](./NOTICE.md)。

各上游名称与商标归各自公司；本插件不是它们的官方产品，也未获背书。
