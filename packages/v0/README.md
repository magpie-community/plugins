# Vercel v0 for Magpie

Connect your [v0 Platform API key](https://v0.app/docs/api) with Magpie's plugin sign-in. The provider lists `v0/v0-mini`, `v0/v0-pro`, `v0/v0-max`, and `v0/v0-max-fast`.

```sh
magpie plugin add ./packages/v0
magpie plugin login v0
magpie provider test v0 v0-mini
```

Every completion creates a private v0 chat at `api.v0.dev` using the selected model. v0 stores the chat and bills the API key's account. For multi-turn inputs, the plugin passes the supplied role-labelled text transcript to the new chat. System and developer roles become labels in that transcript, so their original instruction priority may change. Stream clients receive the completed answer as Chat Completions SSE. A long generation can exceed a routing group's first-token timeout.

This provider supports text. Images, client tool calls, and retrieval of generated project files or previews are outside this adapter's scope. The key is stored by Magpie's plugin sign-in and sent to the official v0 endpoint.
