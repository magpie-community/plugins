// The frpc.toml that runs: made from the form, or the text the user pasted.

import { toml } from "./toml.mjs";

export const NOT_CONFIGURED =
  "frp-connect isn't configured yet: fill in the page, or run " +
  "`magpie plugin options @magpie-community/frp-connect '{...}'` first.";

// check refuses a form that frpc could only fail on, before anything runs,
// and answers the frpc.toml to write.
export function check(cfg) {
  if (cfg.configMode === "toml") {
    const text = String(cfg.frpcToml ?? "").trim();
    if (!text) return { ok: false, error: "paste your frpc.toml, or switch back to the form." };
    return { ok: true, toml: text.endsWith("\n") ? text : text + "\n" };
  }
  if (!cfg.serverAddr) return { ok: false, error: NOT_CONFIGURED };
  if (!cfg.serverPort) return { ok: false, error: "serverPort must be a port (1-65535)." };
  if (!cfg.proxies.some((p) => p.name && p.localPort !== null)) {
    return {
      ok: false,
      error: "add at least one proxy: it needs a name and a localPort (1-65535).",
    };
  }
  return { ok: true, toml: toml(cfg) };
}
