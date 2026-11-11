# opencode-traecli-auth

OpenCode/Magpie provider plugin that sends chat requests through the locally installed `traecli`.

This is for ByteDance internal TRAE CLI usage: the plugin does not implement or store ByteDance auth tokens. It checks that `traecli` is already signed in and then calls `traecli models --json` and `traecli exec --json`.

## Sign in

Preferred order:

1. **Internal Credentials Login**: `traecli login`
   - It uses local Codebase credentials or kinit-based authentication when available.
2. **ByteDance SSO fallback**: `traecli login --sso`
3. **TikTok/USDS SSO fallback**: `traecli login --sso-usds`
4. **Use current TRAE CLI sign-in**
   - Last-resort option when `traecli` is already signed in but the login command cannot run correctly from Magpie.

Recommended first attempt:

```sh
traecli login
traecli login status
```

If the Magpie login flow cannot show an interactive TRAE CLI prompt or browser/device instructions, run the login command in a terminal first, then use the matching Magpie login method:

```sh
traecli login            # Codebase/kinit credentials
# or fallback to SSO:
traecli login --sso      # ByteDance SSO
# or
traecli login --sso-usds # TikTok/USDS SSO
magpie plugin login traecli
```

Then add and login to the Magpie/OpenCode provider:

```sh
magpie plugin add @caikuner/opencode-traecli-auth@latest
magpie plugin login traecli
```

For local development before publishing:

```sh
npm run release:local
magpie plugin add .
magpie plugin login traecli
```

The current tested Magpie build does not support installing this plugin from a local `.tgz`; local tarballs are imported as files instead of unpacked, so Magpie reports `exports no OpenCode plugin function`. Use the project directory for local testing.

## Provider

Provider id: `traecli`

The model list comes from:

```sh
traecli models --json
```

Each chat completion runs:

```sh
traecli exec --json --skip-git-repo-check --ephemeral --ignore-rules --sandbox read-only --model <model> -
```

The request messages are merged into a role-tagged text prompt and written to stdin.

## MVP scope

Supported:

- local `traecli login`, `traecli login --sso`, and `traecli login --sso-usds` session reuse
- model discovery from `traecli models --json`
- OpenAI-compatible `/chat/completions`
- non-streaming response bodies
- streaming SSE shape, with chunks emitted as TRAE CLI JSONL events arrive
- token usage mapping from `turn.completed.usage`

Not supported yet:

- tool calls
- image inputs
- persistent conversations / resume
- token-by-token streaming if `traecli exec --json` only emits final messages
- usage/quota cards
- direct auth/token reverse engineering

## Environment

- `TRAECLI_BIN`: override the binary path. Defaults to `traecli`.
- `TRAECLI_EXEC_TIMEOUT_MS`: completion timeout. Defaults to 10 minutes.
- `TRAECLI_MODELS_TIMEOUT_MS`: model list timeout. Defaults to 30 seconds.
- `TRAECLI_HIGH_LOAD_PERCENT`: append a busy marker to models at or above this load. Defaults to 90.

## End-to-end agent test

The real Magpie/agent smoke test is opt-in because it changes local agent model settings and sends real requests. It intentionally leaves the agents on the test model so you can inspect the resulting Magpie configuration.

```sh
npm run test:e2e
```

Defaults:

- model: `traecli/GPT-5.6-Luna`
- prompt: `只回复 pong，不要解释。`
- agents: Codex, Claude Code, Pi, DeepSeek Harness

Override the model if needed:

```sh
TRAECLI_E2E_MODEL=traecli/GPT-5.6-Luna npm run test:e2e
```

## Release and publishing

Local verification:

```sh
npm run release:local
```

Publish to npm after verifying the package name and npm login:

```sh
npm run publish:npm
```

## Updates

Automatic/update support depends on how the plugin is installed:

- `magpie plugin add @caikuner/opencode-traecli-auth@latest`: updateable with `magpie plugin update` and any Magpie update flow that refreshes npm package specs.
- `magpie plugin add /absolute/path/to/repo`: local development mode; Magpie reads the files in place, so edits apply after refresh/restart, but there is no remote update detection.

## GitHub Actions npm publish

The repository includes `.github/workflows/publish.yml`. It publishes to npm when a tag matching `v*` is pushed, after running `npm test` and `npm run check`.

The workflow publishes with an npm token. Create an npm automation token with package publish permission, then add it as a GitHub Actions repository secret:

- Secret name: `NPM_TOKEN`
- Secret value: the npm automation token

GitHub secret settings: `https://github.com/caikuner/opencode-traecli-auth/settings/secrets/actions`

Release command after GitHub and npm are configured:

```sh
npm run release:publish
```

This runs local verification, creates `v$npm_package_version`, and pushes `main` plus tags. The GitHub Action publishes the package to npm.

Manual npm publish fallback:

```sh
npm run publish:npm
```
