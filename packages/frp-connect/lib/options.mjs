// The plugin's options as the page, the part and the tools read them.

export const DEFAULT_PORT = 7000;

export const PROXY_TYPES = ["tcp", "udp", "http", "https"];

export const TRANSPORTS = ["tcp", "kcp", "quic", "websocket", "wss"];

const text = (v) => (typeof v === "string" ? v.trim() : "");

// port is a TCP/UDP port — 1 to 65535 — or null.
export function port(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  }
  const s = text(value);
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n < 65536 ? n : null;
}

function proxy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const domains = Array.isArray(raw.customDomains)
    ? raw.customDomains
    : String(raw.customDomains ?? "").split(/[\s,]+/);
  return {
    name: text(raw.name),
    type: PROXY_TYPES.includes(text(raw.type)) ? text(raw.type) : "tcp",
    localIP: text(raw.localIP) || "127.0.0.1",
    localPort: port(raw.localPort),
    remotePort: port(raw.remotePort),
    customDomains: domains.map(text).filter(Boolean),
    subdomain: text(raw.subdomain),
  };
}

// options is what the user set, with what a field left out defaults to.
// Nothing an agent writes here starts or stops anything: there is no field
// a command comes through.
export function options(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    frpcBinary: o.frpcBinary === "local" ? "local" : "download",
    frpcPath: text(o.frpcPath),
    autoStart: o.autoStart === true,
    servicePort: port(o.servicePort) ?? 0,
    configMode: o.configMode === "toml" ? "toml" : "form",
    frpcToml: typeof o.frpcToml === "string" ? o.frpcToml : "",
    serverAddr: text(o.serverAddr),
    serverPort: port(o.serverPort) ?? DEFAULT_PORT,
    authMethod: text(o.authMethod) || "token",
    authToken: typeof o.authToken === "string" ? o.authToken : "",
    transport: TRANSPORTS.includes(text(o.transport)) ? text(o.transport) : "tcp",
    proxies: Array.isArray(o.proxies) ? o.proxies.map(proxy).filter(Boolean) : [],
  };
}
