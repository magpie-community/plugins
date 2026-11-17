![ZGAP for magpie: one sign-in, your agents connected](ui/banner.svg)

# ZGAP for magpie

A [magpie](https://usemagpie.ai) plugin that signs in to ZGAP (`https://ai-proxy.zz.gg`) and lets every
agent magpie serves (Claude Code, Codex, OpenCode and the rest) use ZGAP's models.

## Connect in the app

1. Open **Plugins → Discover** in [magpie](https://usemagpie.ai). Search for **ZGAP** and click **Install**.
   If the listing has not appeared yet, enter `github:kargnas/zgap-magpie-plugin` in the
   **Have one in mind?** field at the bottom and click **Install**.
2. Open **Plugins → Installed → ZGAP → Sign in**. You can also use
   **Providers → Add provider → From plugins → ZGAP**.
3. In the browser, sign in with your ZGAP Google account and approve **Authorize magpie**.
   Return to magpie after approval. Only accounts approved by the ZGAP administrator can connect.
4. Open **Agents**, choose your agent, and select a model under **ZGAP**. Follow magpie’s connection
   prompt and restart the agent if requested.

No terminal commands or API-key copying are needed. The **ZGAP** sidebar page and **Settings → Plugins**
panel keep the steps in the app. Right-click a provider or agent and choose **ZGAP setup guide** to
open the relevant step. The plugin follows magpie’s light/dark theme and language.

After sign-in, the same page becomes a compact activity dashboard. It shows the selected ZGAP account’s
24-hour, 7-day or 30-day request totals, token counts, current-catalog cost estimate, daily trend,
model breakdown and live requests. The connection guide remains available under **Show connection guide**.
The dashboard asks ZGAP for only the signed-in account’s data, across that account’s devices and API
keys. OAuth credentials stay in the local service and never reach the page. If the account is signed
out, the page returns to the connection guide.

If you already installed the plugin, use **Plugins → Installed → ZGAP → Update** to get the current
icon and guide.

## Connect from a terminal

```sh
magpie plugin add github:kargnas/zgap-magpie-plugin
magpie plugin login zgap
```

The sign-in shows on the ZGAP console under Connect → OAuth as a `magpie` device. Log it out there to
revoke it. It is a session of its own: signing in here never logs out the [zgap CLI](https://github.com/kargnas/zgap)
on the same computer, and signing in here again updates the same session.

## How it works

- **Models**: read from ZGAP's `/v1/models` once you are signed in. Display names are separate from
  request IDs. Context and output limits, input/output modalities, reasoning, tools and temperature
  support come from the catalog; unknown values remain unspecified.
- **Requests**: ZGAP serves every model on Chat Completions, Messages and Responses, so magpie relays each
  agent's request in the protocol the agent sent it in. The plugin adds the current access token.
- **Tokens**: the access token lasts 24 hours. magpie renews it before it runs out with the refresh token,
  which ZGAP replaces on every renewal and keeps valid for 30 days.

## What ZGAP receives

Like the zgap CLI, each request carries diagnostic context for the ZGAP administrator: the plugin version,
the hostname and OS, the agent's working directory and project name, and the session ID magpie reports.
ZGAP stores it with the request's usage for up to 90 days and removes it before contacting the model
provider. It never includes prompts or command lines.

## Limits

magpie sends a plugin's requests with its own User-Agent and without the agent's own headers, such as
Claude Code's `X-App`.

## Development

```sh
npm ci
npm run build:ui
npm test
npm run test:ui
```

The sidebar entry opens the plugin’s loopback service through magpie’s page-service support. The
service reads ZGAP entries from `plugin-auth.json` inside the config directory supplied by magpie;
magpie owns token renewal and writes. It binds only to `127.0.0.1`, checks Host and Origin, and requires
a random page token for its read-only APIs. It can request only the two ZGAP dashboard endpoints.
The service’s default port is declared by `scripts/build-ui.mjs`; the plugin’s `port` option can move it
if occupied. A port conflict is an error. The settings panel stays static. Authentication stays in
magpie’s native sign-in dialog. Translations live in
`locales/` and use i18next; magpie also reads the translated card summaries and sign-in labels.
`ui/icon.svg` is the icon source. `npm run build:ui` embeds it in the manifest, generates the native
labels and browser translation bundle, and copies i18next with its license into `ui/vendor/`.
Commit those generated assets so installation directly from GitHub works without a build.
`npm test` rejects stale generated files or incomplete translations. `npm run test:ui` checks the
page and panel with Chromium and WebKit; install those test browsers with
`npx playwright install chromium webkit` if needed.

## License

GPL-3.0
