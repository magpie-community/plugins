// Runs in Magpie's embedded moejs sandbox: no Node/Bun APIs, network or external imports.
export const agent = {
  id: "coda",
  name: "Coda Bot",
  icon: "https://codabot.app/favicon.ico",
  dir: "~/.coda",
  config: "~/.coda/magpie.json",
  format: "json",
  model: "defaultModel",
  // Coda Bot sends "CodaBot/<version>"; magpie lowercases the product name before matching.
  ua: ["codabot"],
  notice:
    "New turns in Coda Bot use the selected model immediately; individual Coda bots can pick any Magpie model and set their own reasoning effort. Disconnect before uninstalling. Coda Bot 新一轮对话立即生效，各分身可单独选用任意 Magpie 模型与思考强度；卸载插件前请先断开连接。",
};

const VALID_EFFORTS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const MAX_MODEL_ID_LENGTH = 240;

function isValidModelId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_MODEL_ID_LENGTH &&
    !/[,\s]/.test(id)
  );
}

function normalizeHttpUrl(value, label) {
  if (typeof value !== "string") {
    throw new Error(`Magpie gateway.${label} is unavailable`);
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(trimmed)) {
    throw new Error(`Magpie gateway.${label} is not a valid HTTP(S) URL`);
  }
  return trimmed;
}

function normalizeEfforts(efforts) {
  if (!Array.isArray(efforts)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of efforts) {
    if (typeof raw !== "string") continue;
    const mapped = raw.trim().toLowerCase() === "none" ? "off" : raw.trim().toLowerCase();
    if (VALID_EFFORTS.has(mapped) && !seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }
  return out;
}

function normalizeNativeEndpoints(endpoints) {
  if (!Array.isArray(endpoints)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of endpoints) {
    if (typeof raw !== "string") continue;
    const ep = raw.trim();
    if (ep.startsWith("/") && !/\s/.test(ep) && !seen.has(ep)) {
      seen.add(ep);
      out.push(ep);
    }
  }
  return out;
}

function toCodaModel(m) {
  const id = typeof m?.id === "string" ? m.id.trim() : "";
  if (!isValidModelId(id)) return null;
  const name = typeof m?.name === "string" && m.name.trim() !== "" ? m.name.trim() : id;
  const entry = {
    id,
    name,
    vision: Boolean(m?.images),
    efforts: normalizeEfforts(m?.efforts),
    nativeEndpoints: normalizeNativeEndpoints(m?.native_endpoints),
  };
  const context = Number.isSafeInteger(m?.context) && m.context > 0 ? m.context : 0;
  const output = Number.isSafeInteger(m?.output) && m.output > 0 ? m.output : 0;
  if (context > 0) entry.contextWindow = context;
  if (output > 0) entry.maxOutputTokens = context > 0 ? Math.min(output, context) : output;
  return entry;
}

export function connect({ gateway, model, models } = {}) {
  const url = normalizeHttpUrl(gateway?.url, "url");
  const baseUrl = normalizeHttpUrl(gateway?.v1, "v1");
  const apiKey = typeof gateway?.key === "string" ? gateway.key.trim() : "";
  if (!apiKey) {
    throw new Error("Magpie gateway.key is unavailable");
  }
  if (model !== undefined && model !== null) {
    const selectedId = typeof model?.id === "string" ? model.id.trim() : "";
    if (selectedId && !isValidModelId(selectedId)) {
      throw new Error(`Selected model id ${JSON.stringify(selectedId)} is invalid for Coda Bot`);
    }
  }

  const catalog = [];
  const seenIds = new Set();
  const list = Array.isArray(models) ? models : [];
  for (const item of list) {
    const converted = toCodaModel(item);
    if (converted && !seenIds.has(converted.id)) {
      seenIds.add(converted.id);
      catalog.push(converted);
    }
  }

  const selectedEntry = model ? toCodaModel(model) : null;
  if (selectedEntry && !seenIds.has(selectedEntry.id)) {
    seenIds.add(selectedEntry.id);
    catalog.unshift(selectedEntry);
  }

  // Keep url, baseUrl and apiKey as top-level string keys so Magpie's pluggedStash
  // records st.Mark = "apiKey" and st.Wrote drift checks, while Disconnect deletes
  // every top-level key cleanly without leaving empty nested objects behind.
  return {
    url,
    baseUrl,
    apiKey,
    gateway: {
      version: 1,
      url,
      baseUrl,
      models: catalog,
    },
  };
}
