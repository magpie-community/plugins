// Zap (the OpenWarp fork of Warp, zerx-lab/zap) keeps its BYOP providers in
// ~/.zap/settings.toml, which magpie's agent bridge cannot write: only JSON,
// YAML and env configs are supported. So this plugin works in two halves:
//
//   1. this file — magpie manages a small JSON outbox,
//      ~/.zap/magpie-bridge.json, with the gateway address, the picked model
//      and magpie's whole model catalog;
//   2. index.mjs — a Bun module in the plugin host that mirrors the outbox
//      into ~/.zap/settings.toml as a BYOP provider, and takes it back out
//      when the row is switched off.
export const agent = {
  id: "zap",
  name: "Zap",
  icon: "https://github.com/zerx-lab.png",
  // detection: Zap's settings directory
  dir: "~/.zap",
  // the outbox magpie manages; index.mjs turns it into TOML
  config: "~/.zap/magpie-bridge.json",
  format: "json",
  // the picked model id, written beside what connect writes
  model: "selected",
  // Zap passes the model id upstream as-is, so no prefix
  prefix: "",
  ua: ["zap"],
  notice:
    "Zap reads its BYOP providers from ~/.zap/settings.toml, kept in sync by this plugin; if a running Zap does not pick up a change, restart it. Zap 从 ~/.zap/settings.toml 读取 BYOP 供应商，由本插件保持同步；若运行中的 Zap 没有即时生效，重启 Zap 即可。",
}

export function connect({ gateway, models }) {
  // one whole object per key, so a disconnect takes everything out cleanly
  const catalog = {}
  for (const m of models || []) {
    const entry = { name: m.name || m.id }
    if (m.context > 0) entry.context = m.context
    if (m.images) entry.image = true
    catalog[m.id] = entry
  }
  return {
    base_url: gateway.v1,
    models: catalog,
  }
}
