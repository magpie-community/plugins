import { join } from "node:path";
import { Credentials } from "./src/auth.ts";
import { startOAuth } from "./src/oauth.ts";
import { loadApiCatalog } from "./src/catalog.ts";
import { serviceURL } from "./src/types.ts";

const API = "https://api.goanyapi.com";
const MCP = "https://mcp.goanyapi.com";
const PROVIDER = "goanyapi";
const validName = /^goanyapi_[a-z0-9_]+$/;
const validPath = /^\/api\/v1\/[a-z0-9/_-]+$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function safeBase(url, fallback) {
  const u = serviceURL(url ?? fallback);
  if (u.search || u.hash || u.username || u.password) throw new Error("Invalid GoAnyAPI endpoint");
  return u.href.replace(/\/$/, "");
}

function check(schema, args) {
  if (!isObject(args)) throw new Error("Expected object arguments");
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) if (args[key] === undefined || args[key] === null) throw new Error("Missing required argument: " + key);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) throw new Error("Unknown argument: " + key);
    if (value === undefined || value === null) continue;
    const s = props[key];
    if (s.type === "integer" && (!Number.isInteger(value))) throw new Error("Invalid integer argument: " + key);
    else if (s.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid number argument: " + key);
    else if (s.type === "string" && typeof value !== "string") throw new Error("Invalid string argument: " + key);
    else if (s.type === "boolean" && typeof value !== "boolean") throw new Error("Invalid boolean argument: " + key);
    else if (s.type === "array" && !Array.isArray(value)) throw new Error("Invalid array argument: " + key);
    else if (s.type === "object" && !isObject(value)) throw new Error("Invalid object argument: " + key);
    if (s.enum && !s.enum.includes(value)) throw new Error("Unsupported argument value: " + key);
  }
  return args;
}

function nameOf(def) {
  if (!validName.test(def.mcpName) || !validPath.test(def.path) || def.method !== "GET" || def.readOnly !== true || !isObject(def.inputSchema) || def.inputSchema.type !== "object") return null;
  const name = def.mcpName.slice("goanyapi_".length);
  return name.length > 0 && name.length <= 48 ? name : null;
}

function encodeQuery(args) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) || isObject(value) ? JSON.stringify(value) : String(value));
  }
  return params;
}

async function resultJson(response, label) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("GoAnyAPI " + label + " failed (HTTP " + response.status + ")");
  }
  try { return await response.json(); }
  catch { throw new Error("GoAnyAPI " + label + " returned invalid JSON"); }
}

async function mcpCall(mcpBase, token, method, params, signal) {
  const response = await fetch(mcpBase + "/mcp", {
    method: "POST", redirect: "error",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      "User-Agent": "goanyapi-magpie/0.1.0"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(48_000)])
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error("GoAnyAPI MCP request failed (HTTP " + response.status + ")");
    error.status = response.status;
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  let message;
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const data = text.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trim()).filter(Boolean);
    for (const item of data) { try { const parsed = JSON.parse(item); if (parsed.id === 1) message = parsed; } catch {} }
  } else message = await resultJson(response, "MCP");
  if (!message || message.jsonrpc !== "2.0") throw new Error("GoAnyAPI MCP response is invalid");
  if (message.error) throw new Error("GoAnyAPI MCP returned an error (" + (message.error.code ?? "unknown") + ")");
  return message.result;
}

export async function GoAnyAPITools(input, options = {}) {
  const apiBase = safeBase(options.baseUrl, API);
  const mcpBase = safeBase(options.mcpBaseUrl, MCP);
  const credentials = new Credentials(input, options);
  const definitions = await loadApiCatalog(apiBase);
  const byName = new Map();
  const tool = {};

  async function invoke(def, args, ctx) {
    const name = nameOf(def);
    if (!name) throw new Error("Unsupported GoAnyAPI tool definition");
    const validated = check(def.inputSchema, args);
    const auth = await credentials.token(ctx?.abort);
    const signal = AbortSignal.any([ctx?.abort ?? new AbortController().signal, AbortSignal.timeout(48_000)]);
    if (auth.oauth) {
      let current = auth;
      try { return await mcpCall(mcpBase, current.token, "tools/call", { name: def.mcpName, arguments: validated }, signal); }
      catch (error) {
        if (error.status !== 401) throw error;
        const renewed = await credentials.renew(auth.oauth, signal);
        current = { token: renewed.access, oauth: renewed };
        return mcpCall(mcpBase, current.token, "tools/call", { name: def.mcpName, arguments: validated }, signal);
      }
    }
    const u = new URL(apiBase + def.path);
    u.search = encodeQuery(validated).toString();
    return resultJson(await fetch(u, {
      method: "GET", redirect: "error", signal,
      headers: { authorization: "Bearer " + auth.token, accept: "application/json", "User-Agent": "goanyapi-magpie/0.1.0" }
    }), name);
  }

  for (const def of definitions) {
    const name = nameOf(def);
    if (!name || byName.has(name)) continue;
    byName.set(name, def);
    tool[name] = {
      description: def.description,
      args: def.inputSchema,
      async execute(args, ctx) { return invoke(def, args, ctx); }
    };
  }
  if (!byName.size) throw new Error("GoAnyAPI returned no valid tool definitions");

  tool.catalog = {
    description: "Discover the current GoAnyAPI tool catalog; newly added tools can be invoked with call_dynamic without reinstalling this plugin. Catalog is public and does not consume API credits.",
    args: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const defs = await loadApiCatalog(apiBase, 0);
      return defs.filter(d => nameOf(d)).map(d => ({ name: d.mcpName, description: d.description, inputSchema: d.inputSchema }));
    }
  };
  tool.call_dynamic = {
    description: "Call any current read-only GoAnyAPI tool by its catalog name. First use catalog to discover the latest tools; this works before Magpie restarts after a tool is added.",
    args: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name from GoAnyAPI catalog, e.g. goanyapi_traffic" },
        arguments: { type: "object", description: "Arguments conforming to the selected tool's inputSchema" }
      },
      required: ["name", "arguments"],
      additionalProperties: false
    },
    async execute(value, ctx) {
      if (!isObject(value) || typeof value.name !== "string" || !isObject(value.arguments)) throw new Error("Invalid dynamic call arguments");
      const defs = await loadApiCatalog(apiBase, 0);
      const def = defs.find(x => x.mcpName === value.name && nameOf(x));
      if (!def) throw new Error("Tool is not published in the current GoAnyAPI catalog");
      return invoke(def, value.arguments, ctx);
    }
  };

  return {
    config: async config => { config.provider ??= {}; config.provider[PROVIDER] ??= { name: "GoAnyAPI", models: {} }; },
    auth: {
      provider: PROVIDER, single: true,
      methods: [
        { type: "oauth", label: "Sign in to GoAnyAPI", authorize: () => startOAuth(mcpBase, undefined, join(input.directory, "goanyapi-oauth-client.json")) },
        { type: "api", label: "GoAnyAPI API key" }
      ],
      refreshLead: 60_000,
      refresh: auth => credentials.renew(auth)
    },
    tool
  };
}
