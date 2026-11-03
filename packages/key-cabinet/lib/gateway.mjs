const DEFAULT_GATEWAY = "http://127.0.0.1:3425";

function candidates() {
  const out = [];
  const push = (u) => {
    if (!u) return;
    const s = String(u).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(s) || out.includes(s)) return;
    out.push(s);
  };
  push(process.env.MAGPIE_PROJECT_KEYS_GATEWAY);
  const addr = process.env.MAGPIE_ADDR;
  if (addr && /^[\w.-]+:\d+$/.test(addr)) push("http://" + addr);
  push(DEFAULT_GATEWAY);
  return out;
}

let picked = { at: 0, url: "", scope: "" };

function currentScope() {
  return candidates().join("\n");
}

function authHeaders(extra = {}) {
  const h = { accept: "application/json", ...extra };
  const key = process.env.MAGPIE_API_KEY || process.env.MAGPIE_GATEWAY_KEY || "";
  if (key) h.authorization = "Bearer " + key;
  return h;
}

export async function resolveGateway() {
  const scope = currentScope();
  if (picked.url && picked.scope === scope && Date.now() - picked.at < 60e3) return picked.url;
  for (const url of candidates()) {
    try {
      const res = await fetch(url + "/v1/models", {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        picked = { at: Date.now(), url, scope };
        return url;
      }
    } catch {
      /* next */
    }
  }
  return candidates()[0] || DEFAULT_GATEWAY;
}

export function gatewayURL() {
  const scope = currentScope();
  return (picked.scope === scope && picked.url) || candidates()[0] || DEFAULT_GATEWAY;
}

export async function listModels() {
  const base = await resolveGateway();
  const res = await fetch(base + "/v1/models", {
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return arr
    .map((m) => {
      const id = String(m.id || "");
      return {
        id,
        label: String(m.display_name || m.magpie_label || m.name || id),
        kind: id.startsWith("group/") ? "group" : id ? "model" : "auto",
      };
    })
    .filter((m) => m.id)
    .sort((a, b) => {
      const rank = (x) => (x.kind === "group" ? 0 : 1);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
}
