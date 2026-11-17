# output-strategy

An (unofficial) output-style plugin for magpie, developed and maintained by manjughosa.

Seven composable output styles with a selection panel; **every style is off by default**.

本插件由 manjughosa 独立开发并维护，非官方出品。七种输出样式可以自由组合，全部默认关闭。

The style texts and the original request-injection design are adapted from OmniRoute's Output Styles, caveman, ponytail, i-have-adhd and 9router. Exact sources, revisions, licenses and adaptations are recorded in `PROVENANCE.json`; upstream license files are in `LICENSES/`.

## Styles

- **Terse prose** — remove filler, ceremony and hedging without losing technical content.
- **Less code** — YAGNI and the smallest working change.
- **Ponytail** — lazy senior-developer discipline: reuse, root causes and a complete minimal diff.
- **I have ADHD** — action first, numbered steps and one concrete next action.
- **Terse CJK** — ultra-terse Classical Chinese, with technical identifiers kept verbatim. Unlike OmniRoute's zh-only automatic use, this is an explicit style available for any locale.
- **Antislop UI** — purpose-tested visuals rather than template decoration and dead controls.
- **Antislop copy** — honest, specific copy with accessibility and complete UI states.

Select any combination in the **Output Strategy** panel and save. Styles are combined in catalog order and duplicate boundaries are included only once.

## Options

```json
{
  "styles": {
    "terse-prose": false,
    "less-code": false,
    "ponytail": true,
    "i-have-adhd": false,
    "terse-cjk": false,
    "antislop-ui": false,
    "antislop-copy": false
  }
}
```

No options, an empty options object, or all styles off leaves a request unchanged.

## Request behavior

- **Anthropic and Chat Completions:** append one static style block to the existing system prompt, or create the protocol-appropriate system field when none exists.
- **Responses:** leave `instructions` completely untouched, including Codex's identity and base instructions. Add the style block as a separate `developer` input item.
- **An existing `[Output Strategy]` marker in system/developer instructions:** the body is already considered injected and is left unchanged; old blocks are never stripped or replaced. Quoting the marker in user or assistant messages does not trigger this skip. If an agent replays that marker in system/developer instructions, the saved style remains part of that conversation; turning a style off does not rewrite history. Start a new conversation to begin without the old style block.
- **Cache stability:** a selected style injects consistently across turns. The former `autoClarity` and media-history bypasses are removed because they made the cached system prefix appear and disappear.
- **Unknown or unsupported shapes:** pass through unchanged. Middleware errors fail open.

This package has no Bun gateway hook, telemetry, prompt logging, or writes to the plugin installation folder. The panel reads and writes only `magpie.options` and follows `magpie.theme.lang`.

## Verification

```sh
bun test
node scripts/gen-page-catalog.mjs
```

`page/catalog.js` is generated from `catalog.js`. From the community repository, `output-strategy.test.mjs` runs the same `cases.json` through `../../scripts/middleware.mjs`.

## 中文摘要

7 种输出样式可以自由组合，全部默认关闭。启用后在请求发送前注入固定规则；Responses 不修改 Codex 的 `instructions`，而是另加 developer 输入项。系统/开发者指令中已有 `[Output Strategy]` 标记的请求原样通过；用户或助手消息中引用标记不会触发跳过。切换或关闭样式不会改写已有会话历史，要完整应用新配置请新建会话。为避免提示缓存失效，已移除 autoClarity 和媒体历史绕过；不再提供统计 hook，不保存请求或响应正文，也不写插件安装目录。页面跟随 Magpie 的语言设置。
