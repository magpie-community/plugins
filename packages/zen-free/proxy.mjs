// A pool of HTTP proxies for Zen's requests, used one at a time and sticky:
// the proxy a request succeeded through stays current until it fails, so a
// conversation doesn't look like a new address every turn. A proxy that
// answers 429 (Zen's free-tier limit) or can't be reached rests for a
// cooldown while the next one is tried, and the caller still sees the real
// 429 when every proxy has one. Bun's fetch takes a `proxy` option; another
// runtime can't use these, so configured proxies there throw rather than
// quietly going direct.

const DEFAULT_RETRY_STATUSES = [429];
const DEFAULT_COOLDOWN = 60_000;
const MAX_COOLDOWN = 5 * 60_000;

// Proxy strings as a list: an array, a JSON array, or one per line or comma.
function proxyList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry === "string");
    } catch {}
  }
  return text.split(/[\n,]+/);
}

// The proxies to use, in priority order: the options first, then the
// environment, which lets a host set them once for every provider.
function configured(options) {
  for (const value of [
    options.proxies,
    options.proxy,
    globalThis.process?.env?.ZEN_FREE_PROXIES,
    globalThis.process?.env?.OPENCODE_ZEN_FREE_PROXIES,
  ]) {
    if (value === undefined) continue;
    const list = proxyList(value).map((entry) => entry.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [];
}

// Only HTTP(S) proxies; blank or malformed entries are ignored. Credentials
// stay in the URL for fetch and are never put in an error.
function validProxies(values) {
  const proxies = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      proxies.push(url.href);
    } catch {}
  }
  return proxies;
}

// A retryable response's cooldown: Retry-After in seconds or as a date,
// capped so a bad one can't bench a proxy for long, else the default.
function retryAfter(response, cooldownMs, maxCooldownMs) {
  const header = response.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, Math.min(ms, maxCooldownMs));
  }
  return cooldownMs;
}

export function createProxyPool(options = {}) {
  const customFetch = options.fetchImpl !== undefined || options.fetch !== undefined;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const wanted = configured(options);
  const proxies = validProxies(wanted);
  // A typo or a SOCKS URL leaves nothing usable; going direct would hide
  // the mistake and send the request from the wrong address.
  if (wanted.length && !proxies.length)
    throw new Error("zen-free: no usable HTTP(S) proxy in the configured proxy list");
  // Bun's fetch is the one that knows `proxy`; going direct would defeat a
  // route the user configured, so fail with a clear error instead.
  if (proxies.length && !customFetch && typeof Bun === "undefined") {
    throw new Error(
      "zen-free: proxy failover needs Bun's fetch (the `proxy` option); this runtime is not Bun",
    );
  }

  const statuses = Array.isArray(options.retryStatuses)
    ? options.retryStatuses
    : DEFAULT_RETRY_STATUSES;
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : DEFAULT_COOLDOWN;
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs)
    ? options.maxCooldownMs
    : MAX_COOLDOWN;
  const maxAttempts = Math.max(
    1,
    Math.floor(Number(options.maxAttempts) || proxies.length || 1),
  );

  // When each proxy may be used again, and the one to prefer.
  const cooldowns = new Array(proxies.length).fill(0);
  let current = 0;

  function pick() {
    if (cooldowns[current] <= Date.now()) return current;
    for (let step = 1; step < proxies.length; step++) {
      const next = (current + step) % proxies.length;
      if (cooldowns[next] <= Date.now()) return (current = next);
    }
    // Every proxy is resting: use this one rather than block forever.
    return current;
  }

  function cool(index, ms) {
    cooldowns[index] = Date.now() + Math.max(0, ms);
  }

  function advance(index) {
    current = (index + 1) % proxies.length;
  }

  async function proxyFetch(input, init) {
    if (!proxies.length) return fetchImpl(input, init);

    // A streamed body can't be replayed, so it gets exactly one attempt.
    const streaming = typeof init?.body?.getReader === "function";
    const attempts = streaming ? 1 : Math.min(maxAttempts, proxies.length);
    let response;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const index = pick();
      try {
        // respectNoProxy: false keeps an explicit proxy in effect when the
        // host sets NO_PROXY for opencode.ai. A retry also closes the old
        // connection, so the new proxy gets a fresh one.
        response = await fetchImpl(input, {
          ...init,
          proxy: { url: proxies[index], respectNoProxy: false },
          ...(attempt > 0 ? { keepalive: false } : {}),
        });
      } catch (error) {
        // The caller asked to stop: don't hide that behind another proxy.
        if (init?.signal?.aborted) throw error;
        cool(index, cooldownMs);
        advance(index);
        if (attempt + 1 >= attempts) throw error;
        continue;
      }

      // A real answer (even an error) ends the failover: don't retry it.
      if (!statuses.includes(response.status)) {
        current = index;
        return response;
      }

      cool(index, retryAfter(response, cooldownMs, maxCooldownMs));
      advance(index);
      // The last response goes back as it is, so the caller can read the
      // real 429 body; only a response being retried is cancelled.
      if (attempt + 1 >= attempts) return response;
      await response.body?.cancel().catch(() => {});
    }

    return response;
  }

  return {
    fetch: proxyFetch,
    proxies,
    // For a host or a manual test that wants to say which proxy is current.
    get current() {
      return proxies[current];
    },
  };
}
