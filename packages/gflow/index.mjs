// One exported plugin function. magpie invokes every exported function as a
// plugin, so all helpers live in imported modules or inside GflowPlugin.
// config declares the native image models; auth owns accounts; provider.fetch
// translates magpie's OpenAI images API into the stateless Python bridge.
// Video tools use the same bridge and magpie account, never the CLI session.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkAuth, savedFiles } from "./gflow.mjs";

const PROVIDER_ID = "gflow";
const DEFAULT_MODEL_ID = "nano-banana-2.1";
// Flow's three image menu entries → wire imageModelName (see gflow/api/client.py).
// These are native magpie provider models, not MCP tools: any agent talks to
// magpie's OpenAI-compatible /images/generations endpoint and picks one by id.
const IMAGE_MODELS = [
  { id: "nano-banana-pro", name: "Google Flow · Nano Banana Pro", wire: "GEM_PIX_2" },
  { id: "nano-banana-2.1", name: "Google Flow · Nano Banana 2.1", wire: "BELUGA" },
  { id: "nano-banana-2-lite", name: "Google Flow · Nano Banana 2 Lite", wire: "HARBOR_SEAL" },
];
const MODEL_IDS = new Set(IMAGE_MODELS.map((m) => m.id));
const NPM = "@ai-sdk/openai-compatible";
const API_BASE = "plugin://gflow/v1";
const VIDEO_ASPECTS = ["square", "portrait", "landscape", "16:9", "9:16", "1:1"];
const here = dirname(fileURLToPath(import.meta.url));
// The package carries the gflow Python sources it shells out to, so the
// bridge needs no separate pip install: gflow/ sits beside this file.
const repoRoot = here;

function imageModel({ id, name, wire }, base = API_BASE) {
  return {
    id,
    name,
    api: { id, url: base, npm: NPM },
    limit: { context: 1, output: 1 },
    capabilities: {
      temperature: false,
      reasoning: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: false, image: true, audio: false, video: false, pdf: false },
    },
    modalities: { input: ["text"], output: ["image"] },
    cost: { input: 0, output: 0 },
    status: "active",
    release_date: "",
    tool_call: false,
    reasoning: false,
    free: false,
  };
}

function optionsOf(input, options) {
  // magpie.magpie.options(providerID) returns declared on/off switches;
  // the second argument and input.options are arbitrary plugin options.
  const switches = input?.magpie?.options?.(PROVIDER_ID);
  return {
    ...(options ?? {}),
    ...(switches && typeof switches === "object" ? switches : {}),
    ...((input && typeof input === "object" && input.options) || {}),
  };
}

function explicitPythonOf(o) {
  return o.python || process.env.GFLOW_PYTHON || "";
}

function pythonCandidates(o) {
  const list = [explicitPythonOf(o), "python3"];
  const home = process.env.HOME || "";
  if (home) {
    list.push(join(home, ".pyenv", "shims", "python3"));
    list.push(join(home, ".pyenv", "versions", "3.12.12", "bin", "python3"));
  }
  list.push("/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3");
  return [...new Set(list.filter(Boolean))];
}

function pythonProbe(candidate, cwd, timeoutMs = 8000) {
  // -I deliberately omits cwd/user-site from sys.path.  The bootstrap adds
  // this checkout and the interpreter's user-site back so an editable install
  // is not required.  Import the module here: Python 3.9 can find the files
  // but cannot evaluate gflow's PEP 604 annotations at runtime.
  const code = "import json,sys,site,runpy; " +
    "sys.dont_write_bytecode=True; " +
    "ok=sys.version_info >= (3,10); " +
    "why=''; " +
    "sys.path.insert(0," + JSON.stringify(cwd) + "); " +
    "site.addsitedir(site.getusersitepackages()); " +
    "exec('if ok:\\n try:\\n  import gflow.magpie_bridge, requests, pydantic, websocket\\n except Exception as e:\\n  ok=False; why=type(e).__name__+\": \"+str(e)[:200]'); " +
    "print(json.dumps({'ok':ok and not why,'version':'.'.join(map(str,sys.version_info[:3])),'python':sys.executable,'cwd':" + JSON.stringify(cwd) + ",'reason':why}))";
  const r = spawnSync(candidate, ["-I", "-c", code], {
    encoding: "utf8", timeout: Math.max(1, Math.ceil(timeoutMs)), cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  if (r.error?.code === "ETIMEDOUT" && timeoutMs < 8000) {
    throw new Error("gflow bridge timed out while probing Python");
  }
  if (r.error || r.status !== 0) return null;
  try {
    const answer = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
    return answer.ok ? answer : null;
  } catch {
    return null;
  }
}

let cachedPython = null;
function pythonOf(o, deadline = Infinity) {
  const cwd = o.pythonCwd || o.cwd || process.env.GFLOW_CWD || repoRoot;
  const explicit = explicitPythonOf(o);
  if (explicit) return explicit;
  const key = `${cwd}${delimiter}${process.env.GFLOW_PYTHON || ""}${delimiter}${process.env.PATH || ""}`;
  if (cachedPython?.key === key) return cachedPython.value;
  const problems = [];
  for (const candidate of pythonCandidates(o)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("gflow bridge timed out while locating Python");
    const answer = pythonProbe(candidate, cwd, Math.min(8000, remaining));
    if (answer) {
      cachedPython = { key, value: candidate };
      return candidate;
    }
    problems.push(`${candidate}: incompatible, missing gflow or missing requests/pydantic/websocket`);
  }
  throw new Error(`No usable Python >=3.10 for the gflow bridge (${problems.join("; ")})`);
}

function pythonArgs(cwd) {
  return ["-I", "-c",
    "import runpy,sys,site; " +
    "sys.path.insert(0," + JSON.stringify(cwd) + "); " +
    "site.addsitedir(site.getusersitepackages()); " +
    "sys.argv=['gflow.magpie_bridge']; " +
    "runpy.run_module('gflow.magpie_bridge',run_name='__main__',alter_sys=True)"];
}

function stateDirOf(o) {
  return o.stateDir || o.state_dir || process.env.GFLOW_MAGPIE_STATE_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || process.cwd(), ".config"), "magpie", "gflow");
}

// Cookies travel only through stdin/stdout. The child's argv contains no
// secrets, and stderr is bounded and redacted before it reaches an error.
function pythonBridge(command, cookies, payload, o = {}, hostAccount = PROVIDER_ID, signal, options = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("gflow bridge request aborted"));
      return;
    }
    const cwd = o.pythonCwd || o.cwd || process.env.GFLOW_CWD || repoRoot;
    const timeoutMs = Number(options.timeoutMs ?? o.bridgeTimeoutMs ?? process.env.GFLOW_BRIDGE_TIMEOUT_MS ?? 300_000);
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    let commandPath;
    try {
      commandPath = pythonOf(o, deadline);
      if (explicitPythonOf(o) && !pythonProbe(commandPath, cwd, Math.min(8000, deadline - Date.now()))) {
        if (Date.now() >= deadline) throw new Error("gflow bridge timed out while probing Python");
        throw new Error(`Configured Python cannot import gflow/requests/pydantic/websocket from ${cwd}: ${commandPath}`);
      }
    } catch (e) { reject(e); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error("gflow bridge timed out while locating Python"));
      return;
    }
    const py = spawn(commandPath, pythonArgs(cwd), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(o.bridgeEnv ?? {}), PYTHONUNBUFFERED: "1" },
    });
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const timer = Number.isFinite(remaining) && remaining > 0
      ? setTimeout(() => { py.kill("SIGKILL"); fail(new Error(`gflow bridge timed out after ${Math.round(timeoutMs)}ms`)); }, remaining)
      : null;
    const abort = () => { py.kill("SIGKILL"); fail(new Error("gflow bridge request aborted")); };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    let out = "", err = "";
    const maxOut = 64 * 1024 * 1024;
    py.stdout.on("data", (d) => {
      out += d;
      if (out.length > maxOut) py.kill("SIGKILL");
    });
    py.stderr.on("data", (d) => { if (err.length < 8192) err += d; });
    py.on("error", fail);
    py.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      const clean = String(err).replace(/\x1b\[[0-9;]*m/g, "").slice(-1000);
      if (code !== 0) {
        let message = clean || `gflow bridge exited ${code}`;
        try {
          const parsed = JSON.parse(out);
          if (parsed?.error?.message) message = String(parsed.error.message);
        } catch { /* keep the bounded Python stderr */ }
        reject(new Error(message));
        return;
      }
      try { resolvePromise(JSON.parse(out)); }
      catch (e) { reject(new Error(`gflow bridge returned invalid JSON: ${e.message}`)); }
    });
    const request = {
      ...payload,
      command,
      account: hostAccount,
      state_dir: stateDirOf(o),
      home: o.home || "",
      headers: { "x-gflow-cookies": cookies },
    };
    py.stdin.on("error", () => py.kill("SIGKILL"));
    py.stdin.end(JSON.stringify(request));
  });
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function bridgeFailure(e, fallbackStatus = 502) {
  const message = String(e?.message ?? e).slice(0, 500);
  const auth = /cookie|session expired|401|unauthorized|sign in|reCAPTCHA|CDP/i.test(message);
  const status = auth ? 401 : fallbackStatus;
  return jsonResponse({ error: { message, type: "gflow_bridge_error" } }, status,
    auth ? { "x-magpie-sign-in": "kept" } : {});
}

function cookiesFromHeaders(init, cookies) {
  const headers = new Headers(init?.headers ?? {});
  const found = headers.get("x-gflow-cookies");
  return found && found.trim() ? found.trim() : cookies;
}

const RESERVED_BRIDGE_KEYS = new Set([
  "command", "account", "state_dir", "home", "headers", "cookies", "timeout_seconds",
]);

// magpie sends the selected model in the OpenAI images body as a bare id or a
// `gflow/<id>` qualified id. Normalize it to the bare id and reject unknown
// values so an agent's explicit model choice is never silently substituted.
function normalizedModelId(raw) {
  const value = String(raw ?? "").trim() || DEFAULT_MODEL_ID;
  const id = value.startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;
  if (!MODEL_IDS.has(id)) {
    throw new Error(`unknown gflow image model ${JSON.stringify(value)}; expected one of ${[...MODEL_IDS].join(", ")}`);
  }
  return id;
}

function bodyOf(init) {
  const b = init?.body;
  let body;
  if (typeof b === "string") body = JSON.parse(b || "{}");
  else if (b instanceof Uint8Array) body = JSON.parse(Buffer.from(b).toString("utf8") || "{}");
  else if (ArrayBuffer.isView(b)) body = JSON.parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8") || "{}");
  else if (b && typeof b === "object") body = b;
  else throw new Error("images/generations request body is missing");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("images/generations request body must be an object");
  }
  const reserved = Object.keys(body).filter((key) => RESERVED_BRIDGE_KEYS.has(key));
  if (reserved.length) {
    throw new Error(`images/generations request body contains reserved fields: ${reserved.join(", ")}`);
  }
  return body;
}

function accountName(auth) {
  // Host save() keeps metadata but drops a top-level accountId for API-key
  // sign-ins. Prefer the key persisted by our own success metadata; fall
  // back to legacy fields for accounts saved before that key existed.
  const id = String(auth?.metadata?.gflowAccount ?? auth?.accountId ??
    auth?.metadata?.email ?? auth?.metadata?.name ?? "").trim();
  return id || PROVIDER_ID;
}

function authPathOf(input) {
  if (process.env.GFLOW_MAGPIE_AUTH_PATH) return process.env.GFLOW_MAGPIE_AUTH_PATH;
  const directory = String(input?.directory || "");
  if (directory.endsWith(".json")) return directory;
  return join(directory || process.env.XDG_CONFIG_HOME ||
    join(process.env.HOME || process.cwd(), ".config", "magpie"), "plugin-auth.json");
}

function loadMagpieAccounts(input, requireApi = true) {
  try {
    const stored = JSON.parse(readFileSync(authPathOf(input), "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([key, auth]) =>
      (key === PROVIDER_ID || key.startsWith(`${PROVIDER_ID}#`)) &&
      (!requireApi || auth?.type === "api") &&
      typeof auth?.key === "string" && auth.key));
  } catch {
    return {};
  }
}

function videoAccount(input, hostAccount, requestedId = "") {
  const accounts = loadMagpieAccounts(input);
  const ids = Object.keys(accounts);
  if (!ids.length) {
    throw new Error("No Google Flow account is signed in. Add it in magpie Settings → Providers → Google Flow.");
  }
  if (requestedId) {
    if (accounts[requestedId]) return { key: requestedId, cookies: accounts[requestedId].key };
    throw new Error(`Unknown Google Flow account ${JSON.stringify(requestedId)}. Available accounts: ${ids.join(", ")}`);
  }
  // MCP arguments, not loader context, select the video account.
  if (ids.length !== 1) {
    throw new Error(`Multiple Google Flow accounts are signed in; pass account explicitly: ${ids.join(", ")}`);
  }
  return { key: ids[0], cookies: accounts[ids[0]].key };
}

function videoArgs(args, schema) {
  check(schema, args);
  const wait = args.wait ?? true;
  const timeout = args.timeout ?? 300;
  const payload = {
    prompt: args.prompt,
    aspect_ratio: args.aspect_ratio ?? "landscape",
    wait,
    timeout,
    seed: args.seed,
    output: args.output,
  };
  if (args.media_id !== undefined) payload.media_id = args.media_id;
  // Nulls are omitted before the JSON request to keep the bridge a strict,
  // typed interface and the tool arguments backward compatible.
  return { wait, timeout, payload: Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) };
}

export async function GflowPlugin(input, options = {}) {
  const o = optionsOf(input, options);
  const base = o.apiBase || process.env.GFLOW_MAGPIE_API || API_BASE;
  // keyFor has no account scope at plugin load time, so read it only while
  // authorize/callback/loader is executing. Never cache input.client.
  const accountOf = typeof input?.magpie?.account === "function" ? input.magpie.account : null;
  const hostAccount = () => {
    try {
      const key = accountOf?.(PROVIDER_ID);
      return typeof key === "string" && key.trim() ? key.trim() : PROVIDER_ID;
    } catch {
      return PROVIDER_ID;
    }
  };
  const client = input?.client;
  const saveEmail = async (auth, email) => {
    // Host SDK auth.set writes the account in the current request's scope.
    // Keep every existing field; only fill metadata.email for accounts that
    // were saved before this plugin learned to read the Flow profile email.
    if (!email || !client?.auth?.set || typeof client.auth.set !== "function" ||
        !auth || typeof auth !== "object" || auth.metadata?.email) return;
    try {
      await client.auth.set({
        path: { id: PROVIDER_ID },
        body: { ...auth, metadata: { ...(auth.metadata || {}), email } },
      });
    } catch { /* identity display is best-effort; usage still answers */ }
  };
  const VIDEO_ARGS = {
    type: "object",
    properties: {
      account: { type: "string", description: "Optional magpie Google Flow account id, e.g. gflow or gflow#second" },
      prompt: { type: "string", description: "Video prompt" },
      aspect_ratio: { type: "string", enum: VIDEO_ASPECTS, description: "default landscape" },
      seed: { type: "integer", description: "Random seed for reproducibility" },
      wait: { type: "boolean", description: "Wait for rendering (default true)" },
      timeout: { type: "integer", minimum: 30, maximum: 1800, description: "Max wait seconds (default 300)" },
      output: { type: "string", description: "Output file path" },
    },
    required: ["prompt"],
  };
  const EXTEND_ARGS = {
    ...VIDEO_ARGS,
    properties: { ...VIDEO_ARGS.properties, media_id: { type: "string", description: "Media ID/name of the video to extend" } },
    required: ["media_id", "prompt"],
  };

  return {
    async config(config) {
      config.provider ??= {};
      // ??= keeps a user's own provider/model overrides. Every model must be
      // OpenAI-compatible and image-output only to be discovered as a drawer.
      config.provider[PROVIDER_ID] ??= {
        name: "Google Flow",
        npm: NPM,
        api: base,
        models: Object.fromEntries(IMAGE_MODELS.map((m) => [m.id, {
          name: m.name,
          limit: { context: 1, output: 1 },
          tool_call: false,
          reasoning: false,
          modalities: { input: ["text"], output: ["image"] },
        }])),
      };
      return config;
    },

    provider: {
      id: PROVIDER_ID,
      models: async (provider) => ({
        ...provider.models,
        ...Object.fromEntries(IMAGE_MODELS.map((m) => [m.id, imageModel(m, base)])),
      }),
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: "api",
        keyless: true,
        label: "粘贴 Google Flow Cookie（手动，可能已失效）",
        labels: { en: "Paste Google Flow cookies (manual, may be expired)", zh: "粘贴 Google Flow Cookie（手动，可能已失效）" },
        placeholder: "SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…",
        prompts: [
          {
            type: "password",
            key: "cookies",
            message: "粘贴 Google Flow Cookie 请求头（手动）",
            messages: { zh: "粘贴 Google Flow Cookie 请求头（手动）" },
            placeholder: "SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…",
            validate: (v) => (typeof v === "string" && v.includes("=") && !/[\r\n]/.test(v)
              ? undefined : "Paste one Cookie header value for the Google Flow account."),
          },
        ],
        async authorize(inputs = {}, context = {}) {
          // The masked `cookies` prompt supplies the credential. Older hosts
          // may inject the API-key field as inputs.key instead.
          const cookies = String(inputs.cookies ?? inputs.key ?? "").trim();
          if (!cookies || !cookies.includes("=") || /[\r\n]/.test(cookies)) {
            return { type: "failed", error: "Paste one Cookie header value for the Google Flow account." };
          }
          try {
            const who = await pythonBridge("validate", cookies, {}, o, hostAccount(), context?.signal);
            if (!who.authenticated) return { type: "failed", error: "Flow did not return an access token for these cookies." };
            return {
              type: "success",
              key: cookies,
              metadata: {
                email: who.email || "",
                name: who.name || "",
                gflowAccount: hostAccount(),
                // save() merges method inputs into metadata; keep the
                // credential only in the host-managed `key` field.
                cookies: "",
              },
            };
          } catch (e) {
            return { type: "failed", error: `Flow cookies validation failed: ${String(e.message ?? e).slice(0, 300)}` };
          }
        },
      }, {
        // magpie renders every auth method as a button.  This one opens a
        // clean Chrome/CDP window on Flow; opened:true stops magpie from
        // opening a second browser tab.  auto callback waits for the user to
        // finish the Google login, then saves the captured cookies as an
        // ordinary API account.
        type: "oauth",
        label: "打开 Google Flow 浏览器登录（推荐，自动 CDP）",
        labels: {
          en: "Open Google Flow browser login (recommended, automatic CDP)",
          zh: "打开 Google Flow 浏览器登录（推荐，自动 CDP）",
        },
        async authorize(inputs, context = {}) {
          try {
            const started = await pythonBridge("browser_login_start", "", {}, o, hostAccount(), context?.signal);
            return {
              // An empty URL keeps magpie from opening the old Flow page in
              // its own WebView after authorize already opened Chrome.  The
              // account is saved by the auto callback below.
              url: "",
              instructions: "已打开独立 Chrome 窗口。请在窗口中完成 Google 登录；最多等待 5 分钟。若 Chrome 被关闭、出现错误页或超时，回到 magpie 重试此按钮；成功时 Cookie 会自动保存，无需复制。",
              method: "auto",
              opened: true,
              async callback(_code, cbContext = {}) {
                let who;
                try {
                  who = await pythonBridge("browser_login_wait", "", {
                    timeout_seconds: Number(o.loginTimeoutSeconds ?? 300),
                  }, o, hostAccount(), cbContext?.signal);
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e).slice(0, 300) };
                }
                if (!who.authenticated || !who.cookies) {
                  return { type: "failed", error: "Google Flow login did not produce valid cookies. Close any stale login window and retry the browser button." };
                }
                return {
                  type: "success",
                  key: who.cookies,
                  metadata: {
                    email: who.email || "",
                    name: who.name || "",
                    gflowAccount: hostAccount(),
                  },
                };
              },
            };
          } catch (e) {
            return { type: "failed", error: `Could not open Google Flow: ${String(e.message ?? e).slice(0, 300)}` };
          }
        },
      }],
      async usage(getAuth, provider, context = {}) {
        const auth = await getAuth();
        const cookies = auth?.type === "api" ? String(auth.key || "") : "";
        if (!cookies) return { error: "No Google Flow account is signed in. Add its cookies in magpie Settings → Providers." };
        const configured = Number(o.usageTimeoutMs ?? 15_000);
        const budgetMs = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 15_000) : 15_000;
        const deadline = Date.now() + budgetMs;
        try {
          const info = await pythonBridge("usage", cookies, {}, o, hostAccount(), context?.signal, { timeoutMs: budgetMs });
          const email = String(info?.email || "");
          await saveEmail(auth, email);
          const credits = Number(info?.credits);
          if (!Number.isFinite(credits) || credits < 0) {
            return { user: email || String(auth?.metadata?.email || ""), error: "Flow credit balance was not present in the account reply." };
          }
          return {
            user: email || String(auth?.metadata?.email || ""),
            balance: `${credits} credits`,
            windows: [{
              name: "Flow credits",
              balance: credits,
              unit: "credits",
              display: `${credits} credits left`,
            }],
          };
        } catch (e) {
          // A failed quota read must not start another full bridge timeout.
          let identity = {};
          const remaining = deadline - Date.now();
          if (!auth?.metadata?.email && !context?.signal?.aborted && remaining > 0) {
            identity = await pythonBridge("identity", cookies, {}, o, hostAccount(), context?.signal, { timeoutMs: remaining })
              .catch(() => ({}));
          }
          const email = String(identity?.email || auth?.metadata?.email || "");
          await saveEmail(auth, email);
          return {
            user: email,
            error: String(e?.message ?? e).slice(0, 300),
          };
        }
      },
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) throw new Error("No Google Flow account is signed in. Add its cookies in magpie Settings → Providers.");
        const cookies = auth.key;
        return {
          // pluginFetch replaces this base with the URL under /images/generations;
          // the custom fetch below never sends a network request to it.
          baseURL: "https://gflow.invalid/v1",
          apiKey: "gflow",
          headers: { "x-gflow-cookies": cookies },
          async fetch(req, init = {}) {
            const url = String(req?.url ?? req ?? "");
            if (!/\/images\/generations(?:\?|$)/.test(url)) {
              return jsonResponse({ error: { message: `Unsupported gflow provider route: ${new URL(url).pathname}` } }, 404);
            }
            let payload;
            try {
              payload = bodyOf(init);
              payload = { ...payload, model: normalizedModelId(payload.model) };
            }
            catch (e) { return jsonResponse({ error: { message: e.message } }, 400); }
            const effectiveCookies = cookiesFromHeaders(init, cookies);
            try {
              const answer = await pythonBridge("image", effectiveCookies, payload, o, hostAccount(), init?.signal);
              if (Array.isArray(answer?.data)) return jsonResponse(answer, 200);
              return jsonResponse({ error: { message: "gflow bridge returned no images" } }, 502);
            } catch (e) {
              return bridgeFailure(e);
            }
          },
        };
      },
    },

    tool: {
      gflow_generate_video: {
        description: "Generate a Veo 3.1 video using the signed-in magpie Google Flow account. Returns saved file paths and operation IDs; images use magpie's native gflow image models.",
        args: VIDEO_ARGS,
        async execute(args, context) {
          const { wait, timeout, payload } = videoArgs(args, VIDEO_ARGS);
          const account = videoAccount(input, hostAccount, args.account ?? "");
          return pythonBridge("video", account.cookies, payload, o, account.key, context?.signal, { timeoutMs: (timeout + 120) * 1000 });
        },
      },
      gflow_extend_video: {
        description: "Continue a Veo 3.1 video using the signed-in magpie Google Flow account. Requires media_id from a previous generation.",
        args: EXTEND_ARGS,
        async execute(args, context) {
          const { wait, timeout, payload } = videoArgs(args, EXTEND_ARGS);
          const account = videoAccount(input, hostAccount, args.account ?? "");
          return pythonBridge("extend_video", account.cookies, payload, o, account.key, context?.signal, { timeoutMs: (timeout + 120) * 1000 });
        },
      },
      gflow_auth_status: {
        description: "Check the gflow CLI's ~/.gflow login and the magpie-managed Google Flow accounts. Does not print cookies.",
        args: { type: "object", properties: {} },
        async execute() {
          const accounts = loadMagpieAccounts(input, false);
          let cliStatus;
          try { cliStatus = await checkAuth(o); }
          catch (e) { cliStatus = { authenticated: false, raw: String(e.message ?? e) }; }
          return {
            provider: PROVIDER_ID,
            native_models: IMAGE_MODELS.map((m) => `${PROVIDER_ID}/${m.id}`),
            magpie_accounts: Object.keys(accounts).length,
            video_auth_account: Object.keys(accounts).length === 1 ? Object.keys(accounts)[0] : null,
            cli_authenticated: cliStatus.authenticated,
            cli_status: String(cliStatus.raw ?? "").slice(0, 300),
            video_tools: "use the signed-in magpie account; no ~/.gflow CLI session required",
          };
        },
      },
    },
  };
}
