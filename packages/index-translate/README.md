# Index Translate

Signs in to Bilibili's [Index-Translate](https://github.com/bilibili/Index-Translate)
public API — the free `Index-Translate-35B-A3B` translation model — and makes
its requests. Works in OpenCode and magpie.

- **Sign in**: an API key. The public endpoint accepts any string (the
  official Immersive Translate bridge sends the placeholder `index`), so
  pasting anything signs in. magpie keeps the sign-in in
  `~/.config/magpie/plugin-auth.json` (mode 600), as any plugin's.
- **Models**: `index-translate/Index-Translate-35B-A3B`, on the
  OpenAI-compatible chat completions API.
- **Requests**: every request is sent with thinking disabled
  (`chat_template_kwargs.enable_thinking=false`) and greedy decoding
  (`temperature=0`), exactly as the official bridge sends them — a
  translation model must not reason. A caller's own values are kept.
- **Concurrency**: 4 requests at once per account
  (`magpie.maxConcurrency`; the official guidance is 3–5 per second).

The endpoint is free and public. Its WAF rejects browser-extension
requests (`Origin: chrome-extension://…`), so an extension reaches it
through magpie's gateway (`http://127.0.0.1:3425/v1`) rather than
directly; agents and plugins are served the same way.

```sh
magpie plugin add @magpie-community/opencode-index-translate-auth
magpie plugin login index-translate   # any string as the key
magpie provider test index-translate
```

The model card: 35B total / 3B active MoE on Qwen3.5, 150 languages,
262,144 tokens in the shipped config (the card's vLLM example serves
32,768, which is what the model's context limit here follows).
