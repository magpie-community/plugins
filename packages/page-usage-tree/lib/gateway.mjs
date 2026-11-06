// The gateway answers this page's data through magpie's own usage API.
// Nothing here reads magpie's files: MAGPIE_ADDR is what the plugin host
// gives its plugins, and the gateway is the service that counted the calls.

import http from "node:http";
import https from "node:https";

const DEFAULT_GATEWAY = "http://127.0.0.1:3425";

function normalizeGateway(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(text) ? text : "";
}

export function gatewayCandidates(options = {}) {
  const out = [];
  const push = (value) => {
    const text = normalizeGateway(value);
    if (text && !out.includes(text)) out.push(text);
  };
  push(options.gateway);
  push(process.env.MAGPIE_USAGE_TREE_GATEWAY);
  push(process.env.MAGPIE_GATEWAY);
  const addr = process.env.MAGPIE_ADDR;
  if (addr) {
    const loopback = String(addr).replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:");
    if (/^[\w.-]+:\d+$/.test(loopback)) push(`http://${loopback}`);
  }
  push(DEFAULT_GATEWAY);
  return out;
}

let picked = { at: 0, url: "" };

export function resetGatewayCache() {
  picked = { at: 0, url: "" };
}

function gatewayHeaders() {
  const key = String(process.env.MAGPIE_API_KEY || process.env.MAGPIE_GATEWAY_KEY || "").trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export async function resolveGateway(options = {}) {
  // An explicit gateway belongs to the caller and is never replaced by a
  // remembered one. Tests use this, and so does a manual serve.mjs run.
  if (options.gateway) {
    const explicit = normalizeGateway(options.gateway);
    if (!explicit) throw new Error("invalid Magpie gateway URL");
    return explicit;
  }
  if (picked.url && Date.now() - picked.at < 60_000) return picked.url;
  for (const url of gatewayCandidates(options)) {
    try {
      const res = await fetch(`${url}/v1/magpie/usage?period=today`, {
        headers: gatewayHeaders(),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        picked = { at: Date.now(), url };
        return url;
      }
      await res.body?.cancel().catch(() => {});
    } catch {
      // Try the next candidate.
    }
  }
  return gatewayCandidates(options)[0] || DEFAULT_GATEWAY;
}

function getJSON(url, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      const target = new URL(url);
      const client = target.protocol === "https:" ? https : http;
      request = client.get(
        target,
        {
          agent: false,
          headers: {
            ...gatewayHeaders(),
            Accept: "application/json",
            "Accept-Encoding": "identity",
            Connection: "close",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body = null;
            try {
              body = JSON.parse(raw);
            } catch {
              // Keep body null so a failed response still reports its HTTP status.
            }
            const status = Number(res.statusCode) || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(body?.error || `Magpie gateway returned HTTP ${status}`));
              return;
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              reject(new Error("Magpie gateway returned an invalid JSON object"));
              return;
            }
            resolve(body);
          });
        },
      );
      request.setTimeout(timeout, () => {
        request.destroy(new Error("Magpie gateway request timed out"));
      });
      request.on("error", reject);
    } catch (error) {
      reject(error);
    }
  });
}

function query(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") out.set(key, String(value));
  }
  return out.toString();
}

export async function gatewayUsage(period, options = {}) {
  const base = await resolveGateway(options);
  return getJSON(`${base}/v1/magpie/usage?${query({ period })}`, options.timeout);
}

export async function gatewayRequests(period, options = {}) {
  const base = await resolveGateway(options);
  return getJSON(`${base}/v1/magpie/usage/requests?${query({ period })}`, options.timeout);
}

export async function gatewayAccountRequests(period, account, provider = "", options = {}) {
  const base = await resolveGateway(options);
  return getJSON(
    `${base}/v1/magpie/usage/requests?${query({ period, account, provider })}`,
    options.timeout,
  );
}
