# @magpie-community/opencode-antigravity-auth (retired)

**Retired in 0.2.0. Use [Antigravity (local agy CLI)](../agy-cli/README.md),
`@magpie-community/opencode-agy-cli-auth`, instead.**

Up to 0.1.18 this plugin signed in to Antigravity with a Google account and
sent requests to Google's Code Assist API (`cloudcode-pa.googleapis.com`)
the way the Antigravity app does. Google bans accounts it sees used that
way. Antigravity (local agy CLI) runs the `agy` CLI you installed and signed
in to, over the Agent Client Protocol (`agy acp`), so the requests Google
sees are agy's own.

From 0.2.0 this package sends no request at all:

- every request is answered `410` with a message that says to install
  Antigravity (local agy CLI). magpie reads it as a retired model, so a
  routing group goes on to its next member;
- signing in is turned away with the same message;
- it lists no models, usage or web search.

To move:

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
magpie plugin remove @magpie-community/opencode-antigravity-auth
```

Then sign in to agy once (Plugins › Antigravity (local agy CLI) › Sign in,
or `agy` in a terminal). Antigravity (local agy CLI) serves the one Google
account agy is signed in to.
