# Otari

Otari as a first-class Magpie and OpenCode provider.

The plugin turns the hosted [Otari](https://otari.ai) gateway into a provider
that every agent behind Magpie can use: live Chat models, per-million-token
pricing, routing-policy tiers, per-request usage tags, key budget, balance and
Chat Completions.

## Install

```bash
magpie plugin add @magpie-community/opencode-otari-auth
magpie plugin login otari
```

The login asks for:

1. the region: Global (`api.otari.ai`) or EU (`eu.api.otari.ai`);
2. an Otari API key (`otk_...`), validated against `/models`;
3. an optional Dashboard session: a session cookie, email/password, or skip.

The API key is always used for inference. The Dashboard session is only used for
account-level reads: balance, key budget, reset time, 30-day usage and routing
policies. Skip keeps models, pricing and chat working; the account row then shows
the host's "sign in again" action so a session can be added later.

## Models

Models are addressed as:

```text
otari/<Otari model id>
```

Otari model ids may contain slashes, so the first slash separates the provider
from the model:

```text
otari/deepseek/deepseek-v4.1-flash
```

Otari routing policies are exposed by their policy name:

```text
otari/fast
otari/strong
otari/long
```

That is what lets Magpie's intent-routing groups choose a tier without knowing
which real provider Otari will pick.

## What it does

- Dynamic Chat model discovery from `GET /models`.
- Per-million-token pricing from `GET /models`, with `GET /pricing/current` as a
  fallback. A missing price is unknown, never free.
- Context windows, output limits, input/output modalities, tool-call and
  reasoning flags mapped into Magpie's model shape.
- Routing policies exposed as models, with provider fallback kept inside Otari.
- `Otari-Tags: app=magpie,session=<id>,model=<id>` on every request, so usage can
  be filtered per Magpie conversation.
- Dashboard balance, key budget, reset time, 30-day usage and routing-policy
  visibility.
- Organization provider-key models labelled with the key name, then the
  organization name, then the upstream provider.
- Global and EU endpoints.
- No runtime npm dependencies.

## Two-layer routing

```text
Magpie: intent routing
  quick question  -> otari/fast
  write tests     -> otari/strong
  long context    -> otari/long
        |
        v
Otari: provider routing
  fast   -> cheap open-weight model + failover
  strong -> strong model + failover
  long   -> 1M-context model
```

A routing group in Magpie can use those three models directly:

```bash
magpie group add otari-two-layer models=otari/fast,otari/strong,otari/long
magpie group rule add otari-two-layer use=otari/fast \
  intent="a quick question or explanation, with no code to write or change" \
  classifier=otari/fast
magpie group rule add otari-two-layer use=otari/strong \
  intent="writing or fixing tests, implementing a feature, or changing code"
magpie group rule add otari-two-layer use=otari/long tokens=128000
```

The full recipe, including the Otari policy setup, is in the main repository:

<https://github.com/kabaBZ/magpie-otari-provider/blob/main/docs/two-layer-routing.md>

## Security

- API keys and Dashboard sessions are stored by Magpie in `plugin-auth.json`.
- Passwords are never persisted.
- The plugin does not print keys, cookies or request bodies.
- Dashboard sessions are sensitive and expire. Treat them like passwords.

## Development

```bash
node --test
```

The plugin is plain ESM and has no runtime dependencies. The OpenCode 2.x entry
is the community adapter in `opencode2.mjs`.

## License

MIT. See [LICENSE](LICENSE).
