// magpie-agent-thinkrail — connect-only Magpie agent plugin for JetBrains ThinkRail.
//
// ThinkRail is a thin host around the pi coding agent (pi.dev); it reads model
// providers from ~/.pi/agent/models.json. This plugin lets Magpie own a single
// "magpie" provider entry in that file: connect injects the gateway plus the
// user's model catalog, disconnect restores what was there before (stash and
// restore are handled by Magpie itself).
//
// Shape follows @magpie-community/agent-pig (MIT, magpie-community/plugins),
// including "Match Magpie's Pi adapter": a published output limit cannot
// exceed its window; the provider is stashed and restored as one unit so a
// disconnect never leaves an invalid empty provider behind.
//
// Model switching happens inside ThinkRail's own model picker — pi keeps the
// "current model" outside models.json, so this plugin intentionally does not
// set one.

export const agent = {
  id: "thinkrail",
  name: "ThinkRail",
  // The official ThinkRail mark, from the app's own UI assets (Apache-2.0, see NOTICE.md).
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgLTUzLjUgNTU3IDU1NyI+Cgk8dGl0bGU+VGhpbmtSYWlsPC90aXRsZT4KCTxzdHlsZT4KCQk6cm9vdCB7IGNvbG9yOiBibGFjazsgfQoJCUBtZWRpYSAocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspIHsgOnJvb3QgeyBjb2xvcjogd2hpdGU7IH0gfQoJPC9zdHlsZT4KCTxwYXRoIGZpbGw9ImN1cnJlbnRDb2xvciIgZD0iTTQzMCAxMTEuM0M0MzAgODguNDkgNDExLjUxIDcwIDM4OC43IDcwSDE4OS42OEMxODQuMzMgNzAgMTgwIDc0LjMzIDE4MCA3OS42OFY0NDkuMkgyMjBWMzIxLjI0QzIyMCAyNzcuMjcgMjQ0LjM3IDI1MCAyOTkuNzQgMjUwSDM3NC4xNEM0MDUuMDkgMjUwIDQzMC4xNiAyMjQuODkgNDMwLjEyIDE5My45NUw0MzAgMTExLjNaTTM5MCAxODlDMzkwIDE5OC41NCAzODIuMTkgMjA2LjM1IDM3Mi42NSAyMDYuMzVIMzExLjg2QzI1NC43NCAyMDYuMzUgMjMwLjU5IDIyMi4xIDIyMy42NCAyMjcuODlDMjIyLjc0IDIyOC42NSAyMjEuMzYgMjI4LjAxIDIyMS4zNSAyMjYuODJMMjIwLjA1IDExNC4xOUMyMjAuMDIgMTExLjg5IDIyMS44OSAxMTAgMjI0LjE5IDExMEgzNzQuODdDMzgzLjIyIDExMCAzOTAgMTE2Ljc4IDM5MCAxMjUuMTNMMzkwIDE4OVpNNTAwLjM4IDM1OC42NEw0NjAuMSAyOTQuMDZMNDU4LjA2IDI5MC44QzQ2NS40NiAyODQuNDMgNDcxLjc3IDI3Ny40OSA0NzcuMDUgMjcwLjA4QzQ5Mi41NCAyNDguMzggNDk5LjMgMjIyLjY1IDQ5OS4xOCAxOTUuMzZMNDk5LjExIDE3OS45OEM0OTkuNzUgMTczLjc3IDUwMCAxNzAgNTAwIDE3MEw0OTkuOTggOTguMzVDNDk5Ljk2IDQ0LjAzIDQ1NS45MSA5LjUzNjc0ZS0wNiA0MDEuNTkgOS41MzY3NGUtMDZIMzQwVjMxLjExQzM0MCAzNi4wMiAzNDMuOTggNDAgMzQ4Ljg5IDQwTDM5OC45MSA0MC43OEM0MzMuMDkgNDEuMTcgNDYwLjcyIDY4Ljc2IDQ2MS4xMyAxMDIuOTVMNDYyLjIgMTkxLjE0QzQ2Mi42MyAyMTkuODkgNDYyLjA0IDI1OC4xNSAzOTkuMzEgMjc3LjYzTDUwMy40NCA0NDkuMkg1NTYuMzZMNTAwLjM4IDM1OC42NFpNMzcxLjg0IDI5MS4xOUMzNjcuNTkgMjg0LjI0IDM2MC4wNCAyODAgMzUxLjkgMjgwSDI4OC42NkMyNjYuNzkgMjgwIDI0OS4wNSAyOTcuNzQgMjQ5LjA1IDMxOS42MVY0NDkuMkgyODkuMTFMMjg5LjczIDM0MC42MUMyODkuNzkgMzI5LjIxIDI5OS4wNSAzMjAgMzEwLjQ1IDMyMEgzMzMuODRDMzM3LjY4IDMyMCAzNDEuMjYgMzIxLjk1IDM0My4zNCAzMjUuMThMNDIzLjA2IDQ0OS4ySDQ2OC40TDM3MS44NCAyOTEuMTlaTTE0MC41NyA3MEgwVjExMEgxMTBWNDQ5LjJIMTUwVjc5LjQzQzE1MCA3NC4yMiAxNDUuNzggNzAgMTQwLjU3IDcwWk0wIDBWNDBIMzAxLjg4QzMwNi4zNyA0MCAzMTAgMzYuMzYgMzEwIDMxLjg4VjBIMFoiIC8+Cjwvc3ZnPgo=",
  // Detection: ThinkRail's install root (Windows). No CLI binary to look for.
  dir: "~/AppData/Local/ai.thinkrail.app",
  config: "~/.pi/agent/models.json",
  format: "json",
  ua: ["thinkrail"],
  notice:
    "Restart ThinkRail to see Magpie's models, then pick one in its model picker. Disconnecting restores your previous file. 重启 ThinkRail 后在模型选择器中选择 Magpie 模型；断开连接会还原原配置。",
}

// pi accepts these reasoning levels; map whatever Magpie's catalog publishes.
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

function modelEntry(model) {
  const efforts = model.efforts || []
  const entry = {
    id: model.id,
    name: model.name || model.id,
    input: model.images ? ["text", "image"] : ["text"],
    reasoning: efforts.length > 0,
  }
  // Unknown limits are left to ThinkRail's defaults; zero is invalid in its schema.
  if (model.context > 0) entry.contextWindow = model.context
  // Match Magpie's Pi adapter: a published output limit cannot exceed its window.
  if (model.output > 0) entry.maxTokens = model.context > 0 ? Math.min(model.output, model.context) : model.output
  if (efforts.length > 0) {
    entry.thinkingLevelMap = {}
    for (const level of thinkingLevels) {
      const effort = level === "off" ? "none" : level
      entry.thinkingLevelMap[level] = efforts.includes(effort) ? effort : null
    }
  }
  return entry
}

export function connect({ gateway, models }) {
  // Stash and restore the provider as one unit. Leaf-only writes leave an
  // invalid empty provider after disconnect when no provider existed before.
  // Other provider IDs remain outside this plugin's ownership.
  return {
    "providers.magpie": {
      name: "Magpie",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      // The agentplug hook has no native-protocol field; Magpie translates Chat.
      api: "openai-completions",
      models: models.map(modelEntry),
    },
  }
}
