# @magpie-community/opencode-tokenrhythm-auth

TokenRhythm provider for Magpie / OpenCode.

[中文文档 / Chinese docs](README.zh-CN.md)

## Sign-ins

- **Browser sign-in (managed model key + balance)** — OAuth2 + PKCE loopback
  (the OpenSquilla integration client `opensquilla-desktop`). magpie shows the
  authorize link; the plugin finishes the callback and the managed-key setup by
  itself. The balance card tracks the live wallet (two decimals).
- **API key only** — paste a TokenRhythm model key; models work, the balance
  card needs the OAuth session.

```bash
magpie plugin add <local path or published name>
magpie plugin login tokenrhythm
```

## Key surface

Base URL: `https://tokenrhythm.studio/v1`
(Docs: <https://tokenrhythm.studio/docs/api-integration>)

| Capability | Endpoint |
| --- | --- |
| Model list | `GET /v1/models` |
| OpenAI chat | `POST /v1/chat/completions` |
| Anthropic messages | `POST /v1/messages` |
| Embeddings | `POST /v1/embeddings` |
| Video generations (Wan 3.0) | `POST /v1/videos/generations` |
| JEV decision | `POST /v1/decision`、`POST /v1/systemone` |

- The live model catalog is fetched from `GET /v1/models` (30 models) and
  served as `tokenrhythm-plugin/<model>` through magpie's gateway
  (OpenAI-compatible; Anthropic messages too).
- `NeoHorse-Jev-4B` is declared as the System One decision model
  (`decides: true`) for magpie's routing-group classifier at
  `{BASE}/systemone`; empty choice criteria are rewritten to the option key
  to pass TokenRhythm's validation.
- The same Bearer key works directly against `/v1/embeddings` and
  `/v1/videos/generations`.

```sh
# OpenAI chat
curl https://tokenrhythm.studio/v1/chat/completions \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"hi"}]}'

# Anthropic messages
curl https://tokenrhythm.studio/v1/messages \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# Embeddings
curl https://tokenrhythm.studio/v1/embeddings \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hello"}'

# Video generations (Wan 3.0)
curl https://tokenrhythm.studio/v1/videos/generations \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"wan3.0","prompt":"a sailboat at sunset"}'

# JEV decision
curl https://tokenrhythm.studio/v1/decision \
  -H "Authorization: Bearer $TOKENRHYTHM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"NeoHorse-Jev-4B","criteria":[{"key":"fast","description":"prioritize speed"}],"input":"..."}'
```

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `create_key` | `true` | Obtain/reuse the managed model key after the browser sign-in. |
| `origin` | `https://tokenrhythm.studio` | TokenRhythm origin. |
| `modelBase` | `<origin>/v1` | OpenAI-compatible base. |
| `loginTimeoutMs` | `300000` | Browser sign-in timeout. |

## License

MIT
