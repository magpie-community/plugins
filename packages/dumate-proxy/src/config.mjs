import { homedir } from "node:os"
import { join, resolve } from "node:path"

function intEnv(value, fallback, min = 1) {
  const n = Number.parseInt(String(value ?? ""), 10)
  return Number.isSafeInteger(n) && n >= min ? n : fallback
}

export function loadConfig(env = process.env) {
  const stateDir = resolve(String(env.DUMATE_STATE_DIR || join(homedir(), ".config", "dumate-proxy")))
  return Object.freeze({
    host: String(env.DUMATE_HOST || "127.0.0.1"),
    port: intEnv(env.DUMATE_PORT, 8787, 0),
    stateDir,
    userDataDir: String(env.DUMATE_USER_DATA_DIR || "") || undefined,
    configPath: String(env.DUMATE_OPENCODE_CONFIG || "") || undefined,
    cookie: String(env.DUMATE_COOKIE || "") || undefined,
    cookieFile: String(env.DUMATE_COOKIE_FILE || "") || undefined,
    apiKey: String(env.DUMATE_PROXY_API_KEY || "") || undefined,
    defaultChatModel: String(env.DUMATE_MODEL || "") || undefined,
    defaultImageModel: String(env.DUMATE_IMAGE_MODEL || "") || undefined,
    consoleBase: String(env.DUMATE_CONSOLE_BASE || "https://console.bce.baidu.com").replace(/\/+$/, ""),
    gatewayBase: String(env.DUMATE_GATEWAY_BASE || "https://dumate-svc.baidu.com/gateway/apis/v1").replace(/\/+$/, ""),
    proxyUrl: String(env.DUMATE_PROXY_URL || "http://127.0.0.1:8787/v1").replace(/\/+$/, ""),
    importBind: String(env.DUMATE_IMPORT_BIND || "127.0.0.1"),
    importPort: intEnv(env.DUMATE_IMPORT_PORT, 8788, 0),
    importPublicUrl: String(env.DUMATE_IMPORT_PUBLIC_URL || "").replace(/\/+$/, "") || undefined,
    requestTimeoutMs: intEnv(env.DUMATE_TIMEOUT_MS, 120_000),
    imageTimeoutMs: intEnv(env.DUMATE_IMAGE_TIMEOUT_MS, 180_000),
    imageFetchTimeoutMs: intEnv(env.DUMATE_IMAGE_FETCH_TIMEOUT_MS, 20_000),
    maxImageBytes: intEnv(env.DUMATE_MAX_IMAGE_BYTES, 20 * 1024 * 1024),
    maxBodyBytes: intEnv(env.DUMATE_MAX_BODY_BYTES, 64 * 1024 * 1024),
    logLevel: String(env.DUMATE_LOG_LEVEL || "info").toLowerCase(),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "DuMate/1.0.91 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36",
  })
}
