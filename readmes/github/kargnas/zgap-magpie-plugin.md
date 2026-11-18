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

Open **ZGAP** in the sidebar. Before sign-in you’ll see the connection guide. After sign-in,
**Live activity** opens the same request timeline as the ZGAP web console. Choose **Usage stats**
for the weekly report, time ranges, chart metrics and breakdowns by model, API key, project or device.
If you use more than one ZGAP account, choose one at the top. These views cover that account’s
usage across devices. **Connection guide** stays available, and signing out clears the account’s data.

If you already installed the plugin, use **Plugins → Installed → ZGAP → Update** to get the current
version.

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
- **Speed**: GPT models also carry the speed tiers ZGAP's accounts serve them at (Fast, and Ultrafast where
  available). magpie then offers them in an agent's model picker, a group and the model's own speed setting.
  An agent on Claude's Messages API, such as Claude Code, can only ask for Fast, so Ultrafast runs as Fast there.
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
a random page token for its read-only APIs. It serves the JS and CSS built by the ZGAP console and forwards only the three personal dashboard
reads (live events, usage statistics and weekly report). The asset requests carry no credentials.
No OAuth token is sent to the page or placed in a URL; the stream closes on sign-out or renewal.
The service’s default port is declared by `scripts/build-ui.mjs`; the plugin’s `port` option can move it
if occupied. A port conflict is an error. The settings panel stays static. Authentication stays in
magpie’s native sign-in dialog. Translations live in
`locales/` and use i18next; magpie also reads the translated card summaries and sign-in labels.
`ui/icon.svg` is the icon source. `npm run build:ui` embeds it in the manifest, generates the native
labels and browser translation bundle, and copies i18next with its license into `ui/vendor/`.
Commit those generated assets so installation directly from GitHub works without a build.
`npm test` rejects stale generated files or incomplete translations. `npm run test:ui` checks the
page with the deployed console assets, fixture accounts and both Chromium and WebKit. To run against
a local console build, set Playwright config metadata.consoleBuild to the absolute directory holding
console.js and console.css. For the panel test and dashboard tests, install those test browsers with
`npx playwright install chromium webkit` if needed.

## License

GPL-3.0
