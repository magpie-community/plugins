// frpc.toml, made from the options and read back into them, so the page's
// preview is the file frpc runs and its two modes hand each other the same
// settings.

// quote is a TOML basic string.
export function quote(value) {
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

// toml is the frpc.toml the options make: the server, the auth, a
// transport other than tcp, and one [[proxies]] per proxy. loginFailExit
// is always there — a server that isn't up yet is retried, not given up.
// The same lines in the same order as buildToml in the page (a test holds
// the two together).
export function toml(cfg) {
  const L = [];
  L.push(`serverAddr = ${quote(cfg.serverAddr ?? "")}`);
  L.push(`serverPort = ${quote(cfg.serverPort)}`);
  L.push("loginFailExit = false");
  if (cfg.authToken) {
    L.push(`auth.method = ${quote(cfg.authMethod || "token")}`);
    L.push(`auth.token = ${quote(cfg.authToken)}`);
  }
  if (cfg.transport && cfg.transport !== "tcp") {
    L.push(`transport.protocol = ${quote(cfg.transport)}`);
  }
  L.push("");
  for (const p of cfg.proxies) {
    if (!p.name || p.localPort === null) continue;
    L.push("[[proxies]]");
    L.push(`name = ${quote(p.name)}`);
    L.push(`type = ${quote(p.type)}`);
    L.push(`localIP = ${quote(p.localIP || "127.0.0.1")}`);
    L.push(`localPort = ${quote(p.localPort)}`);
    if (p.type === "http" || p.type === "https") {
      if (p.subdomain) L.push(`subdomain = ${quote(p.subdomain)}`);
      if (p.customDomains.length) {
        L.push(`customDomains = [${p.customDomains.map(quote).join(", ")}]`);
      }
    } else if (p.remotePort !== null) {
      L.push(`remotePort = ${quote(p.remotePort)}`);
    }
    L.push("");
  }
  return L.join("\n").trimEnd() + "\n";
}

// parse reads an frpc.toml back into the options' shape: the top-level
// keys the form has, and its [[proxies]]. Anything else in the file stays
// in toml mode.
export function parse(file) {
  const out = {
    serverAddr: "",
    serverPort: 7000,
    authMethod: "token",
    authToken: "",
    transport: "tcp",
    proxies: [],
  };
  let current = null;
  let common = false;
  const setTop = (key, value) => {
    switch (key) {
      case "serverAddr":
      case "server_addr":
        out.serverAddr = value;
        break;
      case "serverPort":
      case "server_port":
        out.serverPort = Number(value) || value;
        break;
      case "protocol":
        out.transport = value;
        break;
      case "token":
        out.authToken = value;
        out.authMethod = "token";
        break;
      case "method":
        out.authMethod = value;
        break;
    }
  };
  for (const raw of String(file ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[\[proxies\]\]$/.test(line)) {
      if (current) out.proxies.push(current);
      current = {};
      common = false;
      continue;
    }
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      if (current) out.proxies.push(current);
      current = null;
      common = section[1].trim() === "common";
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];
    const parts = key.split(".");
    if (parts.length === 2 && (parts[0] === "auth" || parts[0] === "transport")) {
      setTop(parts[1], unquote(val));
      continue;
    }
    if (!current) {
      if (!common) setTop(key, unquote(val));
      continue;
    }
    const v = unquote(val);
    switch (key) {
      case "name": current.name = v; break;
      case "type": current.type = v; break;
      case "localIP":
      case "local_ip":
        current.localIP = v;
        break;
      case "localPort":
      case "local_port":
        current.localPort = Number(v) || v;
        break;
      case "remotePort":
      case "remote_port":
        current.remotePort = Number(v) || v;
        break;
      case "customDomains":
      case "custom_domains":
        current.customDomains = domains(val);
        break;
      case "subdomain":
        current.subdomain = v;
        break;
    }
  }
  if (current) out.proxies.push(current);
  return out;
}

function unquote(v) {
  let s = String(v ?? "").trim();
  const hash = s.search(/[ \t]#/);
  if (hash >= 0) s = s.slice(0, hash).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function domains(v) {
  let s = String(v ?? "").trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .join(",");
  }
  return unquote(v);
}
