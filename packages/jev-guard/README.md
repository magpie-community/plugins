# @magpie-community/middleware-jev-guard

TypeSafe **Jev System One** guardrail and policy arbiter as [magpie](https://usemagpie.ai) gateway middleware.

It acts as an in-process gatekeeper in Magpie's gateway pipeline, inspecting prompts and requests across all protocols (`chat`, `responses`, `anthropic`, `gemini`) before routing to upstream models.

## Installation

```bash
magpie plugin add @magpie-community/middleware-jev-guard
```

Or from local directory:

```bash
magpie plugin add ./packages/jev-guard
```

## Options

Configure in **Plugins › Installed › Options**, or via CLI:

```bash
magpie plugin options jev-guard '{
  "blocked_patterns": ["__FORCE_MALICIOUS_CRASH__"],
  "reject_message": "Jev Gate: High-risk instruction pattern blocked by System One policy."
}'
```

| Field | Type | Description |
| --- | --- | --- |
| `blocked_patterns` | `string[]` | List of sensitive or dangerous instruction patterns to block |
| `reject_message` | `string` | Custom error message returned on rejection (HTTP 403) |
