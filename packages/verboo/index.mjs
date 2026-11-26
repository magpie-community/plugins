import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER = "verboo";
const ORIGIN = "https://code.verboo.ai";
const BASE_URL = `${ORIGIN}/router/v1`;
const MODELS_URL = `${BASE_URL}/models`;
const CHAT_URL = `${BASE_URL}/chat/completions`;
const TOKEN_URL = `${ORIGIN}/oauth/token`;
const ME_URL = `${ORIGIN}/api/me`;
const SUBSCRIPTIONS_URL = `${ORIGIN}/api/me/subscriptions`;
const STAMINA_URL = `${ORIGIN}/api/me/stamina`;
const TRIAL_STATUS_URL = `${ORIGIN}/api/me/trial-status`;
const ICON_URL = `${ORIGIN}/icon-192x192.png`;
const CLIENT_ID = "verboo-code-cli";
const SCOPE = "user:profile user:inference";
const LOGIN_TIMEOUT_MS = 600_000;
const TOKEN_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 12_000;
const USAGE_TIMEOUT_MS = 12_000;
const REFRESH_LEAD_MS = 60_000;
const FALLBACK_CONTEXT = 32_768;
const FALLBACK_OUTPUT = 8_192;
const PRODUCT_VERSION = "0.2.2-alpha.3";
const USER_AGENT = `verboo-code/${PRODUCT_VERSION} (+https://github.com/verbeux-ai/verboo-code-v2)`;
const ACTIVE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const OFF_LEVELS = new Set(["off", "none"]);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const SDK = "@ai-sdk/openai-compatible";
const PRINTABLE_ASCII = /^[!-~]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROTATED_CACHE_TTL_MS = 300_000;
const ROTATED_CACHE_MAX = 64;
const refreshInflight = new Map();
const storeRefreshInflight = new Map();
const recentlyRotated = new Map();
let rememberedInstallation;

function expired(message) {
  return Object.assign(new Error(message), { signIn: "expired" });
}

function cancelled(message = "登录已取消") {
  return Object.assign(new Error(message), { cancelled: true });
}

function abortError(message = "请求已取消") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function credential(auth) {
  if (!auth) return;
  if (auth.type !== "oauth") throw expired("仅支持 Verboo Code 浏览器登录，请重新登录");
  if (typeof auth.access !== "string") throw expired("Verboo 登录已失效，请重新登录");
  const token = auth.access.trim();
  if (!token || !PRINTABLE_ASCII.test(token)) throw expired("Verboo 登录已失效，请重新登录");
  return token;
}

function hasRefreshMaterial(auth) {
  return (
    auth?.type === "oauth" &&
    typeof auth.refresh === "string" &&
    auth.refresh.trim().length > 0 &&
    typeof auth.installationId === "string" &&
    auth.installationId.trim().length > 0
  );
}

function isTokenDue(auth, now = Date.now()) {
  if (auth?.type !== "oauth") return false;
  if (typeof auth.access !== "string" || !auth.access.trim()) return true;
  const expires = Number(auth.expires);
  return Number.isFinite(expires) && expires > 0 && now >= expires - REFRESH_LEAD_MS;
}

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function parseReasoningMeta(reasoning) {
  if (reasoning === true) return { supported: true, allowOff: false, levels: null };
  if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return { supported: false, allowOff: false, levels: null };
  }
  const named = [reasoning.effort_levels, reasoning.effortLevels].find(Array.isArray);
  if (!named) {
    if (reasoning.enabled === false) return { supported: false, allowOff: false, levels: null };
    return { supported: true, allowOff: false, levels: null };
  }
  let allowOff = false;
  const seen = new Set();
  const levels = [];
  for (const raw of named) {
    if (typeof raw !== "string") continue;
    const level = raw.trim().toLowerCase();
    if (OFF_LEVELS.has(level)) {
      allowOff = true;
      continue;
    }
    if (ACTIVE_LEVELS.includes(level) && !seen.has(level)) {
      seen.add(level);
      levels.push(level);
    }
  }
  if (levels.length === 0) return { supported: false, allowOff: false, levels: null };
  return { supported: true, allowOff, levels };
}

function variantsFromReasoning(meta) {
  if (!meta.supported || !meta.levels) return undefined;
  const keys = [...(meta.allowOff ? ["none"] : []), ...meta.levels];
  return Object.fromEntries(keys.map((level) => [level, {}]));
}

function modelCatalog(data) {
  const models = {};
  const seen = new Set();
  for (const model of data) {
    if (typeof model?.id !== "string" || !model.id.trim()) continue;
    if (seen.has(model.id)) throw new Error("Verboo 模型列表格式无效");
    seen.add(model.id);

    const reasoningMeta = parseReasoningMeta(model.reasoning);
    const variants = variantsFromReasoning(reasoningMeta);
    const context =
      positiveInt(model.contextWindow) ??
      positiveInt(model.context_length) ??
      positiveInt(model.context_window) ??
      FALLBACK_CONTEXT;
    const output = Math.min(
      positiveInt(model.maxOutputTokens) ??
        positiveInt(model.max_output_tokens) ??
        positiveInt(model.max_completion_tokens) ??
        positiveInt(model.max_tokens) ??
        FALLBACK_OUTPUT,
      context,
    );
    const rawName = [model.displayName, model.display_name, model.name].find(
      (value) => typeof value === "string" && value.trim(),
    );
    const name = rawName ? rawName.trim() : model.id;
    const image = model.vision === true;

    models[model.id] = {
      id: model.id,
      name,
      api: { id: model.id, url: BASE_URL, npm: SDK },
      limit: { context, output },
      capabilities: {
        input: { text: true, image },
        output: { text: true },
        attachment: image,
        reasoning: reasoningMeta.supported,
        toolcall: true,
      },
      ...(variants ? { variants } : {}),
    };
  }
  if (data.length > 0 && Object.keys(models).length === 0) {
    throw new Error("Verboo 返回的目录中没有有效的模型 ID");
  }
  return models;
}

function buildModelReasoningIndex(provider) {
  const index = new Map();
  const catalog = provider?.models;
  if (!catalog || typeof catalog !== "object") return index;
  for (const [id, model] of Object.entries(catalog)) {
    if (!model || typeof model !== "object") continue;
    const variantKeys =
      model.variants && typeof model.variants === "object" ? Object.keys(model.variants) : [];
    let allowOff = false;
    const levels = [];
    for (const raw of variantKeys) {
      const level = raw.trim().toLowerCase();
      if (OFF_LEVELS.has(level)) {
        allowOff = true;
      } else if (ACTIVE_LEVELS.includes(level) && !levels.includes(level)) {
        levels.push(level);
      }
    }
    const entry = {
      reasoning: model.capabilities?.reasoning === true || levels.length > 0,
      allowOff,
      levels: levels.length > 0 ? levels : null,
    };
    index.set(id, entry);
    if (typeof model.api?.id === "string" && model.api.id && model.api.id !== id) {
      index.set(model.api.id, entry);
    }
  }
  return index;
}

function installationFilePath() {
  return join(homedir(), ".magpie-verboo", "installation-id");
}

function installationIdOf(filePath = installationFilePath()) {
  const useCache = filePath === installationFilePath();
  if (useCache && rememberedInstallation) return rememberedInstallation;
  try {
    const stored = readFileSync(filePath, "utf8").trim();
    if (UUID.test(stored)) {
      const normalized = stored.toLowerCase();
      if (useCache) rememberedInstallation = normalized;
      return normalized;
    }
  } catch {}
  const created = randomUUID();
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    try {
      const stored = readFileSync(filePath, "utf8").trim();
      if (UUID.test(stored)) {
        const normalized = stored.toLowerCase();
        if (useCache) rememberedInstallation = normalized;
        return normalized;
      }
    } catch {}
    try {
      writeFileSync(filePath, `${created}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {}
  }
  if (useCache) rememberedInstallation = created;
  return created;
}

function correlationHeaders() {
  return {
    "x-request-id": randomUUID(),
    "x-verboo-journey-id": randomUUID(),
    "x-verboo-operation-id": randomUUID(),
  };
}

function headerValue(headers, name) {
  if (!headers) return;
  return new Headers(headers).get(name) ?? undefined;
}

function textBody(body) {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
}

function parseEffortValue(value) {
  if (typeof value !== "string") return { kind: "unspecified" };
  const level = value.trim().toLowerCase();
  if (!level) return { kind: "unspecified" };
  if (OFF_LEVELS.has(level)) return { kind: "off" };
  if (level === "ultra") return { kind: "active", level: "max" };
  if (level === "light") return { kind: "active", level: "low" };
  if (level === "extra_high") return { kind: "active", level: "xhigh" };
  if (ACTIVE_LEVELS.includes(level)) return { kind: "active", level };
  return { kind: "invalid" };
}

function nearestLevel(want, offered) {
  if (offered.includes(want)) return want;
  const wantIdx = ACTIVE_LEVELS.indexOf(want);
  if (wantIdx < 0) return offered[0];
  let best = offered[0];
  let bestDist = Infinity;
  let bestIdx = -1;
  for (const candidate of offered) {
    const idx = ACTIVE_LEVELS.indexOf(candidate);
    if (idx < 0) continue;
    const dist = Math.abs(idx - wantIdx);
    if (dist < bestDist || (dist === bestDist && idx > bestIdx)) {
      best = candidate;
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return best;
}

function shapeChatBody(body, headers, modelIndex) {
  const text = textBody(body);
  if (text === undefined) return body;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return body;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return body;

  const modelInfo = typeof json.model === "string" ? modelIndex?.get(json.model) : undefined;
  const headerEffort = headerValue(headers, "x-magpie-effort");
  const bodyEffort =
    typeof json.reasoning_effort === "string"
      ? json.reasoning_effort
      : typeof json.reasoning?.effort === "string"
        ? json.reasoning.effort
        : "";
  const hasHeaderEffort = typeof headerEffort === "string" && headerEffort.trim().length > 0;
  const requested = parseEffortValue(hasHeaderEffort ? headerEffort : bodyEffort);

  if (json.reasoning && typeof json.reasoning === "object" && !Array.isArray(json.reasoning)) {
    delete json.reasoning.effort;
    if (Object.keys(json.reasoning).length === 0) delete json.reasoning;
  }

  if (modelInfo && !modelInfo.reasoning) {
    delete json.reasoning_effort;
    delete json.thinking;
    return JSON.stringify(json);
  }

  if (requested.kind === "active") {
    const wire = modelInfo?.levels ? nearestLevel(requested.level, modelInfo.levels) : requested.level;
    json.thinking = { type: "enabled" };
    json.reasoning_effort = wire;
  } else if (requested.kind === "off") {
    delete json.reasoning_effort;
    delete json.thinking;
  } else if (requested.kind === "invalid") {
    delete json.reasoning_effort;
  } else if (typeof json.reasoning_effort === "string" && !json.reasoning_effort.trim()) {
    delete json.reasoning_effort;
  }

  return JSON.stringify(json);
}

function signInResponse(mark, message) {
  return new Response(JSON.stringify({ error: { message, type: "authentication_error" } }), {
    status: 401,
    headers: { "content-type": "application/json", "x-magpie-sign-in": mark },
  });
}

function withSignInHeader(response, mark) {
  const headers = new Headers(response.headers);
  headers.set("x-magpie-sign-in", mark);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sameSecret(expected, actual) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loginPage(outcome) {
  const message =
    outcome === "success"
      ? "已登录。可以关闭此窗口，回到 Magpie。"
      : outcome === "cancelled"
        ? "已取消登录。可以关闭此窗口，回到 Magpie。"
        : "登录没有完成。请回到 Magpie 再试一次。";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verboo</title><style>body{font:16px system-ui,sans-serif;background:#17131e;color:#f8f4ff;display:grid;place-content:center;min-height:90vh;margin:24px}h1{color:#ad34fe}p{max-width:38em;line-height:1.6}</style><h1>Verboo</h1><p>${message}</p></html>`;
}

function writeLoginPage(response, outcome, onFinish) {
  if (!response || response.writableEnded || response.destroyed) {
    onFinish?.();
    return;
  }
  const ok = outcome === "success";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onFinish?.();
  };
  response.once("finish", finish);
  response.once("close", finish);
  response
    .writeHead(ok ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      connection: "close",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    })
    .end(loginPage(outcome));
}

function linkedSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(response, attempt) {
  const raw = response?.headers?.get("retry-after");
  if (raw) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 2_000);
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 2_000);
  }
  return Math.min(300 * 2 ** attempt, 1_500);
}

async function fetchSafeGet(url, headers, signal, timeoutMs, maxRetries = 1) {
  const budget = linkedSignal(signal, timeoutMs);
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: budget,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (budget.aborted || attempt >= maxRetries) throw error;
      await sleep(retryDelayMs(null, attempt), budget);
      continue;
    }
    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries && !budget.aborted) {
      const wait = retryDelayMs(response, attempt);
      await response.body?.cancel().catch(() => {});
      await sleep(wait, budget);
      continue;
    }
    return response;
  }
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function exchangeToken(fields, signal) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...correlationHeaders(),
      },
      body: new URLSearchParams({ ...fields, client_id: CLIENT_ID }),
      redirect: "error",
      signal: linkedSignal(signal, TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error?.name === "TimeoutError") throw new Error("Verboo 登录请求超时");
    throw new Error("无法连接 Verboo 登录服务");
  }

  const body = await readBody(response);
  if (!response.ok) {
    if (response.status === 401 || (response.status === 400 && body?.error === "invalid_grant")) {
      throw expired("Verboo 拒绝了这次登录，请重新登录");
    }
    throw new Error(`Verboo 登录失败（HTTP ${response.status}）`);
  }
  const expiresIn = Number(body.expires_in);
  if (
    typeof body.access_token !== "string" ||
    !body.access_token.trim() ||
    !PRINTABLE_ASCII.test(body.access_token.trim()) ||
    typeof body.refresh_token !== "string" ||
    !body.refresh_token.trim() ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    String(body.token_type ?? "").toLowerCase() !== "bearer"
  ) {
    throw new Error("Verboo 登录响应无效");
  }
  return {
    access: body.access_token.trim(),
    refresh: body.refresh_token.trim(),
    expires: Date.now() + expiresIn * 1000,
  };
}

async function profileOf(access, signal) {
  let response;
  try {
    response = await fetchSafeGet(
      ME_URL,
      { authorization: `Bearer ${access}`, accept: "application/json", ...correlationHeaders() },
      signal,
      TOKEN_TIMEOUT_MS,
      1,
    );
  } catch {
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const body = await readBody(response);
  const user = body?.data;
  const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : undefined;
  const id = typeof user?.id === "string" && user.id.trim() ? user.id.trim() : undefined;
  const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : undefined;
  const accountId = email ?? id;
  if (!accountId && !id) return;
  return { accountId, uid: id, email, name };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error instanceof Error ? error : new Error("无法打开本机登录回调"));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      const address = server.address();
      if (!address || typeof address === "string") {
        fail(new Error("无法打开本机登录回调"));
        return;
      }
      resolve(address.port);
    });
  });
}

function takeCallback(request, expectedState) {
  let url;
  try {
    url = new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return { kind: "reject", status: 400 };
  }
  if (url.pathname !== "/callback") return { kind: "reject", status: 404 };

  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  const incoming = states[0] ?? "";
  const validState = states.length === 1 && sameSecret(expectedState, incoming);
  const denied = errors.length > 0 ? errors[0] : null;
  const code = codes[0] ?? "";
  const accepted =
    request.method === "GET" &&
    validState &&
    (denied === null
      ? errors.length === 0 && codes.length === 1 && code.length > 0 && code.length <= 4096
      : errors.length === 1 && denied.length > 0 && codes.length === 0);
  if (!accepted) return { kind: "reject", status: 400 };
  if (denied === "access_denied") return { kind: "cancel" };
  if (denied !== null) return { kind: "fail" };
  return { kind: "code", code };
}

async function startBrowserLogin(parentSignal, options = {}) {
  const installationId = options.installationId ?? installationIdOf();
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let page;
  let settled = false;
  let stopped = false;
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => {});

  const server = createServer((request, response) => {
    const outcome = takeCallback(request, state);
    if (outcome.kind === "reject") {
      response.writeHead(outcome.status, { "cache-control": "no-store", connection: "close" }).end();
      return;
    }
    if (settled || page) {
      response.writeHead(410, { "cache-control": "no-store", connection: "close" }).end();
      return;
    }
    page = response;
    if (outcome.kind === "cancel") finish(cancelled("已取消登录"));
    else if (outcome.kind === "fail") finish(new Error("Verboo 拒绝了这次登录"));
    else finish(undefined, outcome.code);
  });

  const finish = (error, code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectCode(error);
    else resolveCode(code);
  };

  let cleanupTimer;
  const stop = (immediate = false) => {
    if (stopped) {
      if (immediate) {
        clearTimeout(cleanupTimer);
        server.closeAllConnections?.();
      }
      return;
    }
    stopped = true;
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
    if (server.listening) {
      try {
        server.close();
      } catch {}
    }
    server.closeIdleConnections?.();
    if (immediate) {
      clearTimeout(cleanupTimer);
      server.closeAllConnections?.();
    } else {
      cleanupTimer = setTimeout(() => server.closeAllConnections?.(), 250);
      cleanupTimer.unref?.();
    }
  };

  const replyAndStop = (outcome) => {
    if (page) {
      const target = page;
      page = undefined;
      writeLoginPage(target, outcome, () => stop(true));
      stop(false);
    } else {
      stop(true);
    }
  };

  const onAbort = () => {
    finish(cancelled());
    replyAndStop("cancelled");
  };

  const timer = setTimeout(() => {
    finish(new Error("浏览器登录已超时，请重试"));
    replyAndStop("failed");
  }, timeoutMs);
  timer.unref?.();

  if (parentSignal?.aborted) {
    stop(true);
    throw cancelled();
  }
  if (parentSignal) parentSignal.addEventListener("abort", onAbort, { once: true });

  let port;
  try {
    port = await listen(server);
  } catch {
    stop(true);
    throw new Error("无法打开本机登录回调");
  }
  server.on("error", () => {});

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = new URL("/oauth/authorize", ORIGIN);
  for (const [key, value] of Object.entries({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    installation_id: installationId,
  })) {
    url.searchParams.set(key, value);
  }

  return {
    url: url.href,
    installationId,
    redirectUri,
    stop: () => stop(true),
    async result(signal) {
      const onSignal = () => onAbort();
      if (signal) {
        if (signal.aborted) onSignal();
        else signal.addEventListener("abort", onSignal, { once: true });
      }
      try {
        const code = await codePromise;
        if (signal?.aborted) throw cancelled();
        const tokens = await exchangeToken(
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            installation_id: installationId,
          },
          signal,
        );
        if (signal?.aborted) throw cancelled();
        replyAndStop("success");
        return tokens;
      } catch (error) {
        replyAndStop(error?.cancelled ? "cancelled" : "failed");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onSignal);
        stop(false);
      }
    },
  };
}

function accountScopeKey(magpie, auth) {
  if (auth && typeof auth === "object" && auth.type === "oauth") {
    if (typeof auth.uid === "string" && auth.uid.trim()) return `uid:${auth.uid.trim()}`;
    if (typeof auth.accountId === "string" && auth.accountId.trim()) {
      return `id:${auth.accountId.trim().toLowerCase()}`;
    }
  }
  try {
    const key = magpie?.account?.(PROVIDER);
    if (typeof key === "string" && key.trim()) return `acct:${key.trim()}`;
  } catch {}
  if (auth?.type === "oauth" && typeof auth.installationId === "string" && auth.installationId.trim()) {
    return `inst:${auth.installationId.trim()}`;
  }
}

function sameOAuthIdentity(a, b) {
  if (a?.type !== "oauth" || b?.type !== "oauth") return false;
  const instA = typeof a.installationId === "string" ? a.installationId.trim() : "";
  const instB = typeof b.installationId === "string" ? b.installationId.trim() : "";
  if (!instA || instA !== instB) return false;
  const uidA = typeof a.uid === "string" ? a.uid.trim() : "";
  const uidB = typeof b.uid === "string" ? b.uid.trim() : "";
  if (uidA && uidB) return uidA === uidB;
  const acctA = typeof a.accountId === "string" ? a.accountId.trim().toLowerCase() : "";
  const acctB = typeof b.accountId === "string" ? b.accountId.trim().toLowerCase() : "";
  if (acctA && acctB) return acctA === acctB;
  if (uidA || uidB || acctA || acctB) return false;
  return true;
}

function readStoredAuthFallback(directory, magpie, auth) {
  if (typeof directory !== "string" || !directory.trim()) return;
  if (auth?.type !== "oauth") return;
  let all;
  try {
    all = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8"));
  } catch {
    return;
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) return;

  let scopedKey;
  try {
    const key = magpie?.account?.(PROVIDER);
    if (typeof key === "string" && (key === PROVIDER || key.startsWith(`${PROVIDER}#`))) {
      scopedKey = key;
    }
  } catch {}

  const candidates = Object.entries(all).filter(
    ([k, v]) =>
      (k === PROVIDER || k.startsWith(`${PROVIDER}#`)) &&
      v &&
      typeof v === "object" &&
      sameOAuthIdentity(v, auth),
  );

  if (candidates.length === 1) return candidates[0][1];
  if (candidates.length > 1 && scopedKey) {
    const exact = candidates.find(([k]) => k === scopedKey);
    if (exact && (scopedKey.includes("#") || auth.uid || auth.accountId)) return exact[1];
  }
}

function rememberRotatedGrant(installationId, oldRefresh, tokens) {
  const inst = installationId.trim();
  const prev = oldRefresh.trim();
  if (!inst || !prev || !tokens?.access || !tokens?.refresh) return;
  const now = Date.now();
  for (const [k, entry] of recentlyRotated) {
    if (now - entry.at >= ROTATED_CACHE_TTL_MS) recentlyRotated.delete(k);
  }
  const key = `${inst}\n${prev}`;
  recentlyRotated.delete(key);
  recentlyRotated.set(key, {
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    at: now,
  });
  while (recentlyRotated.size > ROTATED_CACHE_MAX) {
    const oldest = recentlyRotated.keys().next().value;
    recentlyRotated.delete(oldest);
  }
}

function resolveRotatedGrant(installationId, refreshToken) {
  const inst = typeof installationId === "string" ? installationId.trim() : "";
  let currentRefresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!inst || !currentRefresh) return;
  const now = Date.now();
  let resolved;
  const visited = new Set([currentRefresh]);
  for (let hops = 0; hops < 8; hops++) {
    const key = `${inst}\n${currentRefresh}`;
    const entry = recentlyRotated.get(key);
    if (!entry || now - entry.at >= ROTATED_CACHE_TTL_MS) {
      if (entry) recentlyRotated.delete(key);
      break;
    }
    resolved = { access: entry.access, refresh: entry.refresh, expires: entry.expires };
    if (visited.has(entry.refresh)) break;
    visited.add(entry.refresh);
    currentRefresh = entry.refresh;
  }
  return resolved;
}

function refreshGrant(auth) {
  if (!hasRefreshMaterial(auth)) {
    throw expired("Verboo 登录已失效，请重新登录");
  }
  const installationId = auth.installationId.trim();
  const refreshToken = auth.refresh.trim();
  const rotated = resolveRotatedGrant(installationId, refreshToken);
  if (rotated) return Promise.resolve(rotated);
  const key = `${installationId}\n${refreshToken}`;
  const existing = refreshInflight.get(key);
  if (existing) return existing;
  const pending = exchangeToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    installation_id: installationId,
    scope: SCOPE,
  })
    .then((tokens) => {
      rememberRotatedGrant(installationId, refreshToken, tokens);
      return tokens;
    })
    .finally(() => {
      if (refreshInflight.get(key) === pending) refreshInflight.delete(key);
    });
  refreshInflight.set(key, pending);
  return pending;
}

async function storeGrant(client, auth, tokens) {
  const next = {
    ...auth,
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
  };
  try {
    await client?.auth?.set?.({ path: { id: PROVIDER }, body: next });
  } catch {}
  return next;
}

function refreshAndStore(client, auth) {
  if (!hasRefreshMaterial(auth)) {
    return Promise.reject(expired("Verboo 登录已失效，请重新登录"));
  }
  const installationId = auth.installationId.trim();
  const refreshToken = auth.refresh.trim();
  const rotated = resolveRotatedGrant(installationId, refreshToken);
  if (rotated) {
    return Promise.resolve({
      ...auth,
      type: "oauth",
      access: rotated.access,
      refresh: rotated.refresh,
      expires: rotated.expires,
    });
  }
  const key = `${installationId}\n${refreshToken}`;
  const existing = storeRefreshInflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const tokens = await refreshGrant(auth);
    return storeGrant(client, auth, tokens);
  })().finally(() => {
    if (storeRefreshInflight.get(key) === pending) storeRefreshInflight.delete(key);
  });
  storeRefreshInflight.set(key, pending);
  return pending;
}

async function safeGetAuth(getAuth) {
  if (typeof getAuth !== "function") return;
  try {
    return await getAuth();
  } catch {
    return;
  }
}

function extractGrantTokens(auth) {
  if (!hasRefreshMaterial(auth)) return;
  const access = typeof auth.access === "string" ? auth.access.trim() : "";
  const refresh = auth.refresh.trim();
  const expires = Number(auth.expires);
  if (!access || !PRINTABLE_ASCII.test(access)) return;
  return {
    access,
    refresh,
    expires: Number.isFinite(expires) && expires > 0 ? expires : Date.now() + REFRESH_LEAD_MS,
  };
}

async function refreshGrantWithRecovery(auth, options = {}) {
  const { getAuth } = options;
  if (!hasRefreshMaterial(auth)) {
    throw expired("Verboo 登录已失效，请重新登录");
  }
  const installationId = auth.installationId.trim();
  const originalRefresh = auth.refresh.trim();
  const originalAccess = typeof auth.access === "string" ? auth.access.trim() : "";

  const cached = resolveRotatedGrant(installationId, originalRefresh);
  if (cached) return cached;

  let target = auth;
  const latestBefore = await safeGetAuth(getAuth);
  if (latestBefore && sameOAuthIdentity(latestBefore, auth) && hasRefreshMaterial(latestBefore)) {
    const latestRefresh = latestBefore.refresh.trim();
    const latestAccess = typeof latestBefore.access === "string" ? latestBefore.access.trim() : "";
    if (latestRefresh !== originalRefresh || (latestAccess && latestAccess !== originalAccess)) {
      if (!isTokenDue(latestBefore)) {
        const extracted = extractGrantTokens(latestBefore);
        if (extracted) return extracted;
      }
      if (latestRefresh !== originalRefresh) {
        target = latestBefore;
      }
    }
  }

  try {
    return await refreshGrant(target);
  } catch (error) {
    const rotatedAfter = resolveRotatedGrant(installationId, target.refresh.trim());
    if (rotatedAfter) return rotatedAfter;

    const latestAfter = await safeGetAuth(getAuth);
    if (latestAfter && sameOAuthIdentity(latestAfter, target) && hasRefreshMaterial(latestAfter)) {
      const latestRefresh = latestAfter.refresh.trim();
      const latestAccess = typeof latestAfter.access === "string" ? latestAfter.access.trim() : "";
      if (latestRefresh !== target.refresh.trim()) {
        if (!isTokenDue(latestAfter)) {
          const extracted = extractGrantTokens(latestAfter);
          if (extracted) return extracted;
        }
        return refreshGrant(latestAfter);
      }
      if (latestAccess && latestAccess !== originalAccess && !isTokenDue(latestAfter)) {
        const extracted = extractGrantTokens(latestAfter);
        if (extracted) return extracted;
      }
    }
    throw error;
  }
}

async function refreshOAuthIfNeeded(auth, usedToken, getAuth, client, signal) {
  if (auth?.type === "oauth" && hasRefreshMaterial(auth)) {
    const cached = resolveRotatedGrant(auth.installationId, auth.refresh);
    if (cached && cached.access !== usedToken) {
      return {
        auth: { ...auth, type: "oauth", access: cached.access, refresh: cached.refresh, expires: cached.expires },
        refreshed: false,
      };
    }
  }
  const latestBefore = await safeGetAuth(getAuth);
  if (
    latestBefore &&
    sameOAuthIdentity(latestBefore, auth) &&
    typeof latestBefore.access === "string" &&
    latestBefore.access.trim() &&
    latestBefore.access.trim() !== usedToken
  ) {
    return { auth: latestBefore, refreshed: false };
  }
  const base = latestBefore && sameOAuthIdentity(latestBefore, auth) ? latestBefore : auth;
  try {
    const next = await awaitWithSignal(refreshAndStore(client, base), signal);
    return { auth: next, refreshed: true };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (base?.type === "oauth" && hasRefreshMaterial(base)) {
      const cachedAfter = resolveRotatedGrant(base.installationId, base.refresh);
      if (cachedAfter && cachedAfter.access !== usedToken) {
        return {
          auth: {
            ...base,
            type: "oauth",
            access: cachedAfter.access,
            refresh: cachedAfter.refresh,
            expires: cachedAfter.expires,
          },
          refreshed: false,
        };
      }
    }
    const latestAfter = await safeGetAuth(getAuth);
    if (
      latestAfter &&
      sameOAuthIdentity(latestAfter, base) &&
      typeof latestAfter.access === "string" &&
      latestAfter.access.trim() &&
      latestAfter.access.trim() !== usedToken
    ) {
      return { auth: latestAfter, refreshed: false };
    }
    if (
      latestAfter &&
      sameOAuthIdentity(latestAfter, base) &&
      hasRefreshMaterial(latestAfter) &&
      hasRefreshMaterial(base) &&
      latestAfter.refresh.trim() !== base.refresh.trim()
    ) {
      const next = await awaitWithSignal(refreshAndStore(client, latestAfter), signal);
      return { auth: next, refreshed: true };
    }
    throw error;
  }
}

async function parseRouterRequest(input, init) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const rawUrl = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  let url;
  try {
    url = new URL(rawUrl).href;
  } catch {
    throw new Error("Verboo Code 请求地址无效");
  }
  const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  const isChat = url === CHAT_URL && method === "POST";
  const isModels = url === MODELS_URL && method === "GET";
  if (!isChat && !isModels) {
    throw new Error("Verboo Code 仅支持模型列表和 Chat Completions");
  }
  const incomingHeaders = init?.headers ?? (isRequest ? input.headers : undefined);
  let rawBody;
  if (init?.body !== undefined) {
    rawBody = init.body;
  } else if (isRequest && input.body !== null) {
    rawBody = await input.text();
  }
  const signal = init?.signal ?? (isRequest ? input.signal : undefined);
  return { url, method, isChat, incomingHeaders, rawBody, signal };
}

function routerRequest(auth, parsed, shapedBody) {
  const token = credential(auth);
  if (!token) throw new Error("请先登录 Verboo Code");

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: parsed.isChat ? "application/json, text/event-stream" : "application/json",
    ...(parsed.isChat ? { "x-request-id": randomUUID(), "user-agent": USER_AGENT } : correlationHeaders()),
  });
  if (parsed.isChat) headers.set("content-type", "application/json");
  return fetch(parsed.url, {
    method: parsed.method,
    body: parsed.isChat ? shapedBody : parsed.rawBody,
    headers,
    signal: parsed.signal,
    redirect: "error",
  });
}

async function chatWithRefresh(auth, input, init, client, options = {}) {
  const { getAuth, modelIndex, resolveModelIndex } = options;
  const parsed = await parseRouterRequest(input, init);
  let current = (await safeGetAuth(getAuth)) ?? auth;
  const activeModelIndex =
    typeof resolveModelIndex === "function" ? resolveModelIndex(current) : modelIndex;
  const shapedBody = parsed.isChat
    ? shapeChatBody(parsed.rawBody, parsed.incomingHeaders, activeModelIndex)
    : parsed.rawBody;

  let refreshed = false;

  if (current?.type === "oauth" && hasRefreshMaterial(current)) {
    const cached = resolveRotatedGrant(current.installationId, current.refresh);
    if (cached && cached.access !== (typeof current.access === "string" ? current.access.trim() : "")) {
      current = { ...current, type: "oauth", access: cached.access, refresh: cached.refresh, expires: cached.expires };
    }
  }

  if (current?.type === "oauth" && isTokenDue(current) && hasRefreshMaterial(current)) {
    try {
      const used = typeof current.access === "string" ? current.access.trim() : "";
      const outcome = await refreshOAuthIfNeeded(current, used, getAuth, client, parsed.signal);
      current = outcome.auth;
      refreshed = outcome.refreshed;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.signIn === "expired") {
        return { response: signInResponse("expired", error.message), auth: current };
      }
      if (typeof current.access !== "string" || !current.access.trim()) {
        return { response: signInResponse("kept", "Verboo 暂时无法刷新登录，请再试一次"), auth: current };
      }
    }
  }

  let usedToken;
  try {
    usedToken = credential(current);
  } catch (error) {
    if (error?.signIn === "expired") {
      return { response: signInResponse("expired", error.message), auth: current };
    }
    throw error;
  }
  if (!usedToken) {
    return { response: signInResponse("expired", "请先登录 Verboo Code"), auth: current };
  }
  let response = await routerRequest(current, parsed, shapedBody);

  if (!parsed.isChat || response.status !== 401) {
    if (refreshed && response.status !== 401) {
      return { response: withSignInHeader(response, "renewed"), auth: current };
    }
    return { response, auth: current };
  }

  await response.body?.cancel().catch(() => {});
  try {
    const outcome = await refreshOAuthIfNeeded(current, usedToken, getAuth, client, parsed.signal);
    current = outcome.auth;
    refreshed = refreshed || outcome.refreshed;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const reply =
      error?.signIn === "expired"
        ? signInResponse("expired", error.message)
        : signInResponse("kept", "Verboo 暂时无法刷新登录，请再试一次");
    return { response: reply, auth: current };
  }

  if (parsed.signal?.aborted) throw abortError();
  response = await routerRequest(current, parsed, shapedBody);
  if (response.status === 401) {
    return { auth: current, response: withSignInHeader(response, "kept") };
  }
  return {
    auth: current,
    response: refreshed ? withSignInHeader(response, "renewed") : response,
  };
}

async function fetchModelsForAccount(auth, signal, client, options = {}) {
  const { getAuth } = options;
  let current = auth;
  const doFetch = async (token) => {
    try {
      return await fetchSafeGet(
        MODELS_URL,
        { authorization: `Bearer ${token}`, accept: "application/json", ...correlationHeaders() },
        signal,
        MODELS_TIMEOUT_MS,
        1,
      );
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      if (error?.name === "TimeoutError") throw new Error("Verboo 模型列表请求超时");
      throw new Error("无法连接 Verboo 模型列表服务");
    }
  };

  if (current?.type === "oauth") {
    const latest = await safeGetAuth(getAuth);
    if (latest && sameOAuthIdentity(latest, current) && typeof latest.access === "string" && latest.access.trim()) {
      current = latest;
    }
    if (hasRefreshMaterial(current)) {
      const cached = resolveRotatedGrant(current.installationId, current.refresh);
      if (cached) {
        current = {
          ...current,
          type: "oauth",
          access: cached.access,
          refresh: cached.refresh,
          expires: cached.expires,
        };
      }
    }
  }

  if (current?.type === "oauth" && isTokenDue(current) && hasRefreshMaterial(current)) {
    try {
      const used = typeof current.access === "string" ? current.access.trim() : "";
      const outcome = await refreshOAuthIfNeeded(current, used, getAuth, client, signal);
      current = outcome.auth;
    } catch (error) {
      if (error?.name === "AbortError" || error?.signIn === "expired") throw error;
      if (typeof current.access !== "string" || !current.access.trim()) {
        throw new Error("Verboo 暂时无法刷新登录，请再试一次");
      }
    }
  }

  const token = credential(current);
  if (!token) return null;

  let response = await doFetch(token);
  if (response.status === 401 && current?.type === "oauth" && hasRefreshMaterial(current)) {
    await response.body?.cancel().catch(() => {});
    const outcome = await refreshOAuthIfNeeded(current, token, getAuth, client, signal);
    current = outcome.auth;
    const nextToken = credential(current);
    response = await doFetch(nextToken);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      throw expired("Verboo 拒绝了登录（HTTP 401）");
    }
    throw new Error(`Verboo 模型列表请求失败（HTTP ${response.status}）`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Verboo 模型列表格式无效");
  }
  if (!Array.isArray(payload?.data)) throw new Error("Verboo 模型列表格式无效");
  return modelCatalog(payload.data);
}

async function fetchUsageJson(url, access, signal, optional = false) {
  let response;
  try {
    response = await fetchSafeGet(
      url,
      { authorization: `Bearer ${access}`, accept: "application/json", ...correlationHeaders() },
      signal,
      USAGE_TIMEOUT_MS,
      1,
    );
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw abortError();
    return { ok: false, status: 0, error };
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: 401, unauthorized: true };
  }
  if (response.status === 404 && optional) {
    await response.body?.cancel().catch(() => {});
    return { ok: true, status: 404, missing: true, body: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status };
  }
  const body = await readBody(response);
  return { ok: true, status: response.status, body };
}

function formatStaminaWindow(row, singlePlanName) {
  if (!row || typeof row !== "object") return null;
  const remaining = Number(row.remainingPercent);
  if (!Number.isFinite(remaining)) return null;
  const clampedRemaining = Math.max(0, Math.min(100, remaining));
  const used = Math.round((100 - clampedRemaining) * 10) / 10;
  const groupName = typeof row.groupName === "string" && row.groupName.trim() ? row.groupName.trim() : "";
  const name = groupName && groupName !== singlePlanName ? `${groupName} Stamina` : "Stamina";
  const parts = [`${Math.round(clampedRemaining)}% 剩余`];
  const tps = positiveInt(row.nextOutputTps);
  if (tps) parts.push(`${tps} tok/s`);
  if (row.recovering === true) parts.push("恢复中");
  return {
    name,
    used,
    ...(typeof row.fullAt === "string" && row.fullAt.trim() ? { resetsAt: row.fullAt.trim() } : {}),
    display: parts.join(" · "),
    aside: true,
  };
}

function summarizeOAuthUsage(auth, results, refreshed) {
  const meData = results.me.ok ? results.me.body?.data : undefined;
  const subsData = results.subs.ok && Array.isArray(results.subs.body?.data) ? results.subs.body.data : [];
  const staminaData = results.stamina.ok && Array.isArray(results.stamina.body?.data) ? results.stamina.body.data : [];
  const trialData = results.trials.ok ? results.trials.body?.data : undefined;

  const user =
    (typeof meData?.email === "string" && meData.email.trim()) ||
    (typeof auth?.accountId === "string" && auth.accountId.trim()) ||
    (typeof meData?.id === "string" && meData.id.trim()) ||
    undefined;

  const activeSubs = subsData.filter((s) => {
    const st = String(s?.status ?? "").toLowerCase();
    return st === "active" || st === "trialing";
  });
  const pastDueSubs = subsData.filter((s) => String(s?.status ?? "").toLowerCase() === "past_due");
  const primarySubs = activeSubs.length > 0 ? activeSubs : pastDueSubs;

  const planNames = [
    ...new Set(
      primarySubs
        .map((s) => {
          const name = (typeof s?.group?.name === "string" && s.group.name.trim()) || "";
          if (!name) return "";
          return String(s?.status ?? "").toLowerCase() === "past_due" ? `${name} (逾期)` : name;
        })
        .filter(Boolean),
    ),
  ];

  let plan = planNames.join(" + ");
  const rawUntil = primarySubs.find((s) => typeof s?.currentPeriodEnd === "string" && s.currentPeriodEnd.trim())
    ?.currentPeriodEnd;
  let until = rawUntil ? rawUntil.trim() : undefined;
  let renew;
  if (activeSubs.length > 0 && typeof activeSubs[0]?.cancelAtPeriodEnd === "boolean") {
    renew = activeSubs[0].cancelAtPeriodEnd ? "off" : "auto";
  }

  const singlePlanName = activeSubs.length === 1 ? planNames[0] : "";
  const windows = [];
  for (const row of staminaData) {
    const win = formatStaminaWindow(row, singlePlanName);
    if (win) windows.push(win);
  }

  const trials = Array.isArray(trialData?.trials) ? trialData.trials : [];
  const hasPaidAccess = activeSubs.length > 0 || (Array.isArray(trialData?.paidGroupIds) && trialData.paidGroupIds.length > 0);
  for (const trial of trials) {
    if (!trial || typeof trial !== "object") continue;
    if (!plan && trial.state !== "ended") {
      plan = trial.source === "free_tokens" ? "Free Tokens" : "Trial";
    }
    if (!until && typeof trial.endsAt === "string" && trial.endsAt.trim()) {
      until = trial.endsAt.trim();
    }
    const limit = positiveInt(trial.tokenLimit);
    const remaining =
      typeof trial.tokensRemaining === "number" && Number.isFinite(trial.tokensRemaining) && trial.tokensRemaining >= 0
        ? Math.floor(trial.tokensRemaining)
        : undefined;
    if (limit && remaining !== undefined) {
      const amount = Math.max(0, limit - remaining);
      const used = Math.min(100, Math.round((amount / limit) * 1000) / 10);
      windows.push({
        name: trial.source === "free_tokens" ? "Free Tokens" : "Trial",
        used,
        amount,
        limit,
        unit: "tokens",
        ...(typeof trial.endsAt === "string" && trial.endsAt.trim() ? { runsOutAt: trial.endsAt.trim() } : {}),
        ...(hasPaidAccess ? { aside: true } : {}),
      });
    }
  }

  return {
    ...(user ? { user } : {}),
    ...(plan ? { plan } : {}),
    ...(until ? { until } : {}),
    ...(renew ? { renew } : {}),
    windows,
    ...(refreshed ? { signIn: "renewed" } : {}),
  };
}

async function readAccountUsage(getAuth, signal, client) {
  let current = await safeGetAuth(getAuth);
  if (!current) {
    return { error: "请先登录 Verboo Code", signIn: "kept", windows: [] };
  }

  if (current.type !== "oauth") {
    return { error: "仅支持 Verboo Code 浏览器登录，请重新登录", signIn: "expired", windows: [] };
  }

  let refreshed = false;
  if (isTokenDue(current) && hasRefreshMaterial(current)) {
    try {
      const used = typeof current.access === "string" ? current.access.trim() : "";
      const outcome = await refreshOAuthIfNeeded(current, used, getAuth, client, signal);
      current = outcome.auth;
      refreshed = outcome.refreshed;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.signIn === "expired") {
        return { error: error.message, signIn: "expired", windows: [] };
      }
      if (typeof current.access !== "string" || !current.access.trim()) {
        return { error: "Verboo 暂时无法刷新登录，请再试一次", signIn: "kept", windows: [] };
      }
    }
  }

  let token;
  try {
    token = credential(current);
  } catch (error) {
    return { error: error.message, signIn: "expired", windows: [] };
  }

  const fetchAll = async (access) => {
    const [me, subs, stamina, trials] = await Promise.all([
      fetchUsageJson(ME_URL, access, signal, false),
      fetchUsageJson(SUBSCRIPTIONS_URL, access, signal, false),
      fetchUsageJson(STAMINA_URL, access, signal, true),
      fetchUsageJson(TRIAL_STATUS_URL, access, signal, true),
    ]);
    return { me, subs, stamina, trials };
  };

  let results = await fetchAll(token);
  const anyUnauthorized =
    results.me.unauthorized ||
    results.subs.unauthorized ||
    results.stamina.unauthorized ||
    results.trials.unauthorized;

  if (anyUnauthorized && hasRefreshMaterial(current)) {
    try {
      const outcome = await refreshOAuthIfNeeded(current, token, getAuth, client, signal);
      current = outcome.auth;
      refreshed = refreshed || outcome.refreshed;
      results = await fetchAll(credential(current));
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.signIn === "expired") {
        return { error: error.message, signIn: "expired", windows: [] };
      }
      return { error: "Verboo 暂时无法刷新登录，请再试一次", signIn: "kept", windows: [] };
    }
  }

  if (results.me.unauthorized || results.subs.unauthorized) {
    return { error: "Verboo 登录已失效，请重新登录", signIn: "expired", windows: [] };
  }

  if (!results.me.ok && !results.subs.ok) {
    return { error: "无法获取 Verboo 账号用量信息", signIn: "kept", windows: [] };
  }

  return summarizeOAuthUsage(current, results, refreshed);
}

export const _internal = {
  PROVIDER,
  ORIGIN,
  BASE_URL,
  MODELS_URL,
  CHAT_URL,
  TOKEN_URL,
  ME_URL,
  SUBSCRIPTIONS_URL,
  STAMINA_URL,
  TRIAL_STATUS_URL,
  ICON_URL,
  USER_AGENT,
  credential,
  parseReasoningMeta,
  variantsFromReasoning,
  modelCatalog,
  buildModelReasoningIndex,
  installationIdOf,
  parseEffortValue,
  nearestLevel,
  shapeChatBody,
  takeCallback,
  startBrowserLogin,
  exchangeToken,
  profileOf,
  accountScopeKey,
  sameOAuthIdentity,
  readStoredAuthFallback,
  resolveRotatedGrant,
  refreshGrant,
  refreshGrantWithRecovery,
  refreshAndStore,
  parseRouterRequest,
  chatWithRefresh,
  fetchModelsForAccount,
  readAccountUsage,
  resetState() {
    rememberedInstallation = undefined;
    refreshInflight.clear();
    storeRefreshInflight.clear();
    recentlyRotated.clear();
  },
};

export default {
  id: "magpie-verboo",
  async server(input) {
    const client = input?.client;
    const magpie = input?.magpie;
    const directory = typeof input?.directory === "string" ? input.directory : undefined;
    const accountModelIndexes = new Map();
    const accountAuthReaders = new Map();

    const rememberAuthReader = (auth, getAuth) => {
      if (typeof getAuth !== "function") return;
      const key = accountScopeKey(magpie, auth);
      if (key) accountAuthReaders.set(key, getAuth);
    };

    const getAuthFor = (auth) => {
      const key = accountScopeKey(magpie, auth);
      const registered = key ? accountAuthReaders.get(key) : undefined;
      if (registered) return registered;
      if (directory && auth?.type === "oauth") {
        return async () => readStoredAuthFallback(directory, magpie, auth);
      }
    };

    return {
      async config(config) {
        config.provider ??= {};
        const existing =
          config.provider[PROVIDER] && typeof config.provider[PROVIDER] === "object"
            ? config.provider[PROVIDER]
            : {};
        config.provider[PROVIDER] = {
          name: "Verboo Code",
          npm: SDK,
          api: BASE_URL,
          models: {},
          ...existing,
        };
      },

      auth: {
        provider: PROVIDER,
        icon: ICON_URL,
        refreshLead: REFRESH_LEAD_MS,
        rotating: true,
        methods: [
          {
            type: "oauth",
            label: "浏览器登录",
            labels: {
              zh: "浏览器登录",
              "zh-TW": "瀏覽器登入",
              en: "Sign in with Verboo",
            },
            async authorize(_inputs, context) {
              const flow = await startBrowserLogin(context?.signal);
              return {
                url: flow.url,
                instructions: "在浏览器中登录 Verboo。完成后会自动回到 Magpie。",
                method: "auto",
                async callback(_code, callbackContext) {
                  try {
                    const signal = callbackContext?.signal;
                    const tokens = await flow.result(signal);
                    const profile = await profileOf(tokens.access, signal);
                    return {
                      type: "success",
                      access: tokens.access,
                      refresh: tokens.refresh,
                      expires: tokens.expires,
                      installationId: flow.installationId,
                      ...(profile?.accountId ? { accountId: profile.accountId } : {}),
                      ...(profile?.uid ? { uid: profile.uid } : {}),
                    };
                  } catch (error) {
                    if (error?.cancelled) return { type: "failed", error: "登录已取消" };
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Verboo 登录失败",
                    };
                  }
                },
              };
            },
          },
        ],
        async refresh(auth) {
          if (auth?.type !== "oauth") return;
          return refreshGrantWithRecovery(auth, { getAuth: getAuthFor(auth) });
        },
        async usage(getAuth, _provider, options = {}) {
          const auth = await safeGetAuth(getAuth);
          rememberAuthReader(auth, getAuth);
          return readAccountUsage(getAuth, options?.signal, client);
        },
        async loader(getAuth, provider) {
          let auth = await getAuth();
          rememberAuthReader(auth, getAuth);
          const loaderScopeKey = accountScopeKey(magpie, auth);
          const fallbackIndex = buildModelReasoningIndex(provider);
          if (loaderScopeKey && fallbackIndex.size > 0) {
            accountModelIndexes.set(loaderScopeKey, fallbackIndex);
          }
          const resolveModelIndex = (current) => {
            const currentKey = accountScopeKey(magpie, current);
            return (
              (currentKey ? accountModelIndexes.get(currentKey) : undefined) ??
              (loaderScopeKey ? accountModelIndexes.get(loaderScopeKey) : undefined) ??
              fallbackIndex
            );
          };
          return {
            baseURL: BASE_URL,
            async fetch(input, init) {
              const outcome = await chatWithRefresh(auth, input, init, client, {
                getAuth,
                resolveModelIndex,
              });
              auth = outcome.auth;
              return outcome.response;
            },
          };
        },
      },

      provider: {
        id: PROVIDER,
        async models(provider, { auth, signal } = {}) {
          const catalog = await fetchModelsForAccount(auth, signal, client, {
            getAuth: getAuthFor(auth),
          });
          if (!catalog) return provider.models;
          const key = accountScopeKey(magpie, auth);
          if (key) accountModelIndexes.set(key, buildModelReasoningIndex({ models: catalog }));
          return catalog;
        },
      },
    };
  },
};
