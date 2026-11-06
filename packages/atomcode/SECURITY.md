# Security Policy

## Reporting a vulnerability

Do not open a public issue for a credential leak, request-routing bypass, signature flaw, or other exploitable behavior.

Use GitHub's private **Security advisories** flow for this repository:

https://github.com/magpie-community/plugins/security/advisories/new

Include the affected version, a minimal reproduction, impact, and any suggested mitigation. Remove access tokens, refresh tokens, OAuth state values, account identifiers, and personal paths from logs and screenshots.

## Supported versions

Security fixes target the latest published `0.3.x` release and the current
`main` branch. Older commits and local forks are not supported.

## Security boundaries

- Browser tokens are stored by magpie. CLI-backed tokens remain in
  `~/.atomcode/auth.toml`; renewals preserve unrelated content and use an
  atomic private (`0600`) replacement.
- Tokens are never logged or printed.
- Signed model traffic is restricted to the official gateway origin; redirects are refused.
- Configurable OAuth and CodingPlan endpoints must use the exact official hosts
  on HTTPS port 443.
- Upstream model URLs are accepted only when their origin matches the signed gateway.
- OAuth login redirects are restricted to AtomGit and metadata responses are size-bounded.
- Request bodies that cannot be replayed byte-for-byte are rejected; buffered
  bodies are capped at 64 MiB.
- Only 401 and explicit credential/session 403 responses may refresh the
  account. Plan, quota and other entitlement 403 responses keep the sign-in.
- The diagnostics service binds only to `127.0.0.1`, validates `Host` and
  `Origin`, requires a random per-process token for APIs, and sends a strict CSP.
  It never calls AtomGit or the LLM gateway.
- The persisted diagnostics state is schema-filtered and atomically written with
  `0600` permissions. It excludes access and refresh tokens, complete account
  ids, email addresses, prompts and raw upstream responses.
