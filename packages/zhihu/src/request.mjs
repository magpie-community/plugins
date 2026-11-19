// 知乎 REST 接口的请求封装。
//
// 知乎在失败时同样返回 HTTP 200，真正的结果在响应体的 Code 字段里，
// 所以这里必须检查 Code，而不是只看 HTTP 状态码。
//
// 重试只针对“再试一次有意义”的失败（网络错误、HTTP 5xx/429、
// 50002/90001/30003）；额度类失败（30001/30002）重试只会再烧一次额度。

import { apiURL, REQUEST_TIMEOUT, RETRY, USER_AGENT } from "./config.mjs";

export class APIError extends Error {
  constructor(message, { code, status, retryAfter, retryable } = {}) {
    super(message);
    this.name = "APIError";
    if (code !== undefined) this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
    if (retryable !== undefined) this.retryable = retryable;
  }
}

// 401/额度错误让 magpie 可以歇一下这个账号或换下一个搜索源。
export class AuthenticationError extends APIError {
  constructor(message, details) {
    super(message, { ...details, retryable: false });
    this.name = "AuthenticationError";
  }
}

const CODE_TEXT = {
  0: "成功",
  10001: "参数错误",
  20001: "Access Secret 鉴权失败",
  30001: "请求频率或每日额度超限",
  30002: "累计额度已用尽",
  30003: "触发风控，暂时不可用",
  50002: "检索失败",
  90001: "服务内部错误",
};

// 可以安全重试的错误码：检索失败、内部错误、风控（换个时间点可能就好了）。
const TRANSIENT_CODES = new Set([30003, 50002, 90001]);

function fail(message, code, status, retryAfter) {
  const text = `${message}（${code} ${CODE_TEXT[code] ?? "未知错误"}）`;
  return code === 20001
    ? new AuthenticationError(text, { code, status })
    : new APIError(text, { code, status, retryAfter, retryable: TRANSIENT_CODES.has(code) });
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const reason = () => signal?.reason ?? new DOMException("Aborted", "AbortError");
    if (signal?.aborted) return reject(reason());
    const onAbort = () => {
      clearTimeout(timer);
      reject(reason());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function delayFor(retryAfter, attempt, config) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, config.maxDelay);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      const ms = at - Date.now();
      if (ms > 0) return Math.min(ms, config.maxDelay);
    }
  }
  const backoff = config.baseDelay * 2 ** (attempt - 1);
  return Math.min(backoff, config.maxDelay) + Math.floor(Math.random() * 100);
}

// 发一个 GET 请求并解包 {Code, Message, Data}，成功时返回 Data。
export async function request({
  baseUrl,
  path,
  token,
  query,
  signal,
  retry = RETRY,
  logger,
}) {
  if (!token) {
    throw new AuthenticationError("尚未配置知乎 Access Secret。", { status: 401 });
  }

  const attempts = Math.max(1, Number(retry?.attempts) || 1);
  const config = {
    baseDelay: Number(retry?.baseDelay) || 0,
    maxDelay: Number(retry?.maxDelay) || 0,
  };

  const send = async () => {
    const url = new URL(apiURL(baseUrl, path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      // 必须与服务端时间相差 10 分钟以内。
      "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
      "User-Agent": USER_AGENT,
    };

    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT)];
    if (signal) signals.push(signal);

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === "TimeoutError") {
        // 超时已经吃掉一次完整预算，再试一次容易超出工具 55 秒的上限。
        throw new APIError(`知乎 ${path} 请求超时（${REQUEST_TIMEOUT / 1000} 秒）。`, {
          retryable: false,
        });
      }
      // fetch 的错误信息不含凭据，可以原样透出。
      throw new APIError(`无法连接知乎接口：${error?.message ?? error}`, {
        retryable: true,
      });
    }

    const retryAfter = response.headers.get("retry-after") ?? undefined;

    // 错误响应体可能回显凭据，不把它拼进消息。
    if (!response.ok) {
      await response.body?.cancel();
      throw new APIError(`知乎 ${path} 请求失败（HTTP ${response.status}）。`, {
        status: response.status,
        retryAfter,
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new APIError(`知乎 ${path} 返回了无法解析的 JSON。`, {
        status: response.status,
        retryable: false,
      });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new APIError(`知乎 ${path} 返回了非预期的响应。`, {
        status: response.status,
        retryable: false,
      });
    }

    const code = Number(body.Code);
    if (!Number.isFinite(code) || code !== 0) {
      const message =
        typeof body.Message === "string" && body.Message && body.Message !== "success"
          ? `${body.Message}`
          : "请求失败";
      throw fail(message, Number.isFinite(code) ? code : -1, response.status, retryAfter);
    }

    return body.Data;
  };

  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    try {
      const data = await send();
      logger?.("debug", `${path} ok (${Date.now() - started}ms, attempt ${attempt}/${attempts})`);
      return data;
    } catch (error) {
      const elapsed = Date.now() - started;
      const canRetry = error?.retryable === true && attempt < attempts && !signal?.aborted;
      if (!canRetry) {
        logger?.(
          "warn",
          `${path} failed after ${elapsed}ms (attempt ${attempt}/${attempts}): `
            + `${error?.name ?? "Error"}${error?.code !== undefined ? ` ${error.code}` : ""}`,
        );
        throw error;
      }
      const delay = delayFor(error.retryAfter, attempt, config);
      logger?.(
        "info",
        `${path} transient failure after ${elapsed}ms (${error.message}); retrying in ${delay}ms`,
      );
      await sleep(delay, signal);
    }
  }
}