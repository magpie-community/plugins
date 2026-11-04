/**
 * 受控浏览器登录：用本机 Edge/Chrome 的一个临时实例完成 OAuth 授权码捕获。
 *
 * The login capture follows the console's own OIDC walk, stopped at the redirect through CDP:
 *   the plugin: a temporary Chromium window; CDP stops the redirect where it lands and reads the code
 *
 *
 * 两者都保证：
 *   - 抓取发生在官方 SPA 消费 code 之前（SPA 从未加载，code 从未到过它的手上）；
 *   - code 用**我们自己生成的 PKCE verifier** 交换（手工 state 不被官方 SPA 承认）；
 *   - 登录全程落在一次性 profile 里，不碰日常浏览器的 cookie 与登录态，
 *     关闭时整个 profile 目录删除。
 *
 * 回调到达时用一张"登录成功"页面替换掉导航（Fetch.fulfillRequest），
 * 而不是放行——这样 SPA 依然不会执行。
 *
 * 两处针对 Bun 1.3.1（Windows）原生崩溃的规避，改代码前请先看 detach() 与
 * removeProfile() 的说明：收尾时**不**调用 WebSocket.close()，也**不**用
 * Bun 的 rmSync 递归删目录——两者单独测没事，和"CDP 会话刚结束"叠在一起会
 * 偶发 panic: Segmentation fault，而插件宿主是长驻进程，崩了会连累 magpie。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 默认只拦官方控制台域名的请求（自测时可用本地域名复现同一流程）。 */
const DEFAULT_CALLBACK_HOST = "platform.sensenova.cn";

/** 浏览器候选（Windows 优先；未来 mac/linux 同规则）。MAGPIE_SENSENOVA_BROWSER 可覆盖。 */
function candidates() {
  const env = process.env.MAGPIE_SENSENOVA_BROWSER;
  const out = [];
  if (env) out.push(env);
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  const home = process.env.HOME;
  if (process.platform === "win32") {
    if (pf86) out.push(join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    if (pf) out.push(join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    if (pf86) out.push(join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    if (pf) out.push(join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    if (local) out.push(join(local, "Google", "Chrome", "Application", "chrome.exe"));
    if (local) out.push(join(local, "Microsoft", "Edge", "Application", "msedge.exe"));
  } else if (process.platform === "darwin") {
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    out.push("/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  if (home) out.push(join(home, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"));
  return out;
}

/** 找到所有可用的 Chromium 系浏览器（去重）。 */
export function browserCandidates(explicit) {
  if (explicit && typeof explicit === "string") {
    if (existsSync(explicit)) return [explicit];
    throw new Error(`指定的浏览器不存在: ${explicit}`);
  }
  const seen = new Set();
  const out = [];
  for (const p of candidates()) {
    if (p && existsSync(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  if (!out.length) {
    throw new Error(
      "没有找到 Microsoft Edge 或 Chrome。请安装 Edge，或用环境变量 MAGPIE_SENSENOVA_BROWSER 指定浏览器可执行文件路径。",
    );
  }
  return out;
}

/** 找到首选的 Chromium 系浏览器；找不到时给出可操作的报错。 */
export function findBrowser(explicit) {
  return browserCandidates(explicit)[0];
}

/**
 * 给浏览器一个干净的环境。
 *
 * magpie 的 GUI 宿主会带 `__COMPAT_LAYER` 之类的兼容层变量；Edge 继承后
 * 会走 `--edge-skip-compat-layer-relaunch` 重启，重启后的进程不写
 * `DevToolsActivePort`，窗口就停在 about:blank。CLI 启动没有这些变量，
 * 所以同一套代码在 CLI 里正常、在 app 里黑屏。
 */
function browserEnv() {
  const env = { ...process.env };
  for (const key of ["__COMPAT_LAYER", "COMPAT_LAYER", "CHROME_HEADLESS", "ELECTRON_RUN_AS_NODE"]) {
    delete env[key];
  }
  return env;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function htmlPage(title, body, ok) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.7 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background:#0f1115; color:#e8e8ea; }
  main { text-align:center; padding:0 32px; max-width:420px; }
  .badge { width:64px; height:64px; margin:0 auto 18px; border-radius:50%;
           display:grid; place-items:center; font-size:32px;
           background:${ok ? "rgba(52,199,123,.15)" : "rgba(255,92,92,.15)"}; }
  h1 { font-size:19px; margin:0 0 8px; font-weight:600; }
  p { margin:0; color:#9aa0a6; font-size:13.5px; }
</style></head>
<body><main><div class="badge">${ok ? "✅" : "⚠️"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/** 极简 CDP 客户端：send(method, params) + on(event)。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closers = new Set();
    ws.onmessage = (e) => this.dispatch(e);
    ws.onclose = () => {
      for (const fn of this.closers) {
        try {
          fn();
        } catch {}
      }
    };
  }

  static async connect(port, { timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline && !page) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
        const list = await res.json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {
        /* 端口刚起来时可能还没有页面目标 */
      }
      if (!page) await sleep(100);
    }
    if (!page) throw new Error("浏览器的调试端口没有可用的页面目标");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接浏览器调试 WebSocket 超时")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("浏览器调试 WebSocket 连接失败"));
      };
    });
    return new Cdp(ws);
  }

  dispatch(e) {
    let msg = null;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      return;
    }
    if (msg?.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg?.method) {
      for (const fn of this.handlers) {
        try {
          fn(msg);
        } catch {}
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(fn) {
    this.handlers.add(fn);
  }

  onClose(fn) {
    this.closers.add(fn);
  }

  /**
   * 丢掉引用但不调用 ws.close()。
   *
   * Bun 1.3.1 在 Windows 上"关掉 CDP WebSocket + 立刻杀进程/删目录"会偶发
   * 原生段错误（panic: Segmentation fault）。插件宿主是长驻进程，崩了会连累
   * 整个 magpie，所以这里只解除回调引用：浏览器进程被杀之后这条连接自然断开，
   * 迟到的 onclose 也不会再触发任何东西。
   */
  detach() {
    this.handlers.clear();
    this.closers.clear();
    this.pending.clear();
    this.ws = null;
  }
}

/** 结束整个浏览器进程树（Windows 上 child.kill 不够干净）。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* 进程可能已经退出 */
  }
}

/**
 * 删除一次性 profile 目录。
 *
 * Windows 上刻意不用 Bun 的 rmSync：Bun 1.3.1 在"CDP 连接刚关闭 + 递归删除
 * Edge profile"这个组合下会偶发原生崩溃（panic: Segmentation fault），
 * 而插件宿主是长驻进程，崩了会连累整个 magpie。交给系统 rmdir 做，
 * 失败也只是留下一个临时目录，不影响登录结果。
 */
async function removeProfile(dir) {
  for (let i = 0; i < 12; i++) {
    if (process.platform === "win32") {
      // cmd 会把 & ^ | < > 等元字符拆开（实测 `C:\a&b` 会被当成两条命令，
      // 目标目录删不掉还会执行额外片段）。路径含元字符时改走 rmSync：
      // 这条分支只发生在 CDP 从未建立的启动失败场景，无 Bun 崩溃风险。
      if (/[&^|<>"]/.test(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
          return true;
        } catch {
          /* 文件锁：稍后重试 */
        }
      } else {
        // spawnSync 会把带空格的参数正确传给 cmd；不要自己拼一整条命令串，
        // 那会在 cmd 里产生嵌套引号错误（实测 status 123）。
        const r = spawnSync("cmd", ["/c", "rmdir", "/s", "/q", dir], { stdio: "ignore", windowsHide: true });
        if (r.status === 0) return true;
      }
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        /* 文件锁：稍后重试 */
      }
    }
    await sleep(500); // Edge 释放 profile 文件锁需要一点时间
  }
  return !existsSync(dir);
}

async function waitForDebugPort(portFile, child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* 文件还没写出来 */
    }
    if (exited) throw new Error("浏览器启动后立刻退出了（被策略拦截？）");
    await sleep(120);
  }
  throw new Error(
    "浏览器没有写出调试端口，启动失败。若 magpie 以管理员或兼容模式运行，请用普通权限重启后再试；也可以改用“仅 API Key”登录。",
  );
}

/**
 * 打开受控浏览器并等待授权回跳，捕获 code。
 *
 * @param {object} o
 * @param {string} o.authorizeUrl 要导航到的授权地址
 * @param {string} [o.expectedState] 必须匹配的 state（防串会话）
 * @param {number} [o.timeoutMs] 用户完成登录的总预算
 * @param {boolean} [o.headless] 无头（自测用；真实登录必须有头，用户要能看见并操作）
 * @param {string} [o.browserPath] 指定浏览器可执行文件
 * @param {(msg: string) => void} [o.log] 诊断日志
 * @returns {Promise<{result: Promise<{code: string, state: string, redirectUrl: string}>, close: () => Promise<void>}>}
 *   result 在抓到 code 时兑现；窗口被关 / 用户拒绝 / 超时会拒绝。
 *   close() 关浏览器 + 删临时 profile（幂等；失败路径也会自动收尾）。
 */
export async function startLoginCapture({
  authorizeUrl,
  expectedState = "",
  callbackHost = DEFAULT_CALLBACK_HOST,
  timeoutMs = 8 * 60 * 1000,
  headless = false,
  browserPath,
  log = () => {},
}) {
  const exes = browserCandidates(browserPath);
  // 环境变量指定的浏览器不存在时 candidates() 会静默跳过——至少说一声。
  const envBrowser = process.env.MAGPIE_SENSENOVA_BROWSER;
  if (envBrowser && !existsSync(envBrowser)) {
    log(`MAGPIE_SENSENOVA_BROWSER 指定的浏览器不存在，已忽略: ${envBrowser}`);
  }
  if (process.env.__COMPAT_LAYER || process.env.COMPAT_LAYER) {
    log("检测到兼容层变量，浏览器启动时会移除，避免 Edge 重启后丢失调试端口");
  }

  let child = null;
  let profileDir = "";
  let portFile = "";
  let cdp = null;

  for (let idx = 0; idx < exes.length; idx++) {
    const exe = exes[idx];
    profileDir = mkdtempSync(join(tmpdir(), "magpie-sensenova-login-"));
    portFile = join(profileDir, "DevToolsActivePort");
    const args = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // 隐私：把浏览器自己的后台联网关掉。登录窗口只该跟商汤通信——这几项关掉的是
      // 组件更新、实验变体、账号同步、崩溃上报、域名可靠性探测等浏览器自身的请求；
      // 页面发起的请求（登录页、跳转）不受影响。收尾时整个 profile 目录删除。
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--no-service-autorun",
      "--disable-breakpad",
      "--no-pings",
      "--window-size=480,800",
      "about:blank",
    ];
    if (headless) args.unshift("--headless=new");

    log(headless ? `启动无头登录浏览器: ${exe}` : `打开登录窗口（${exe}）`);
    child = spawn(exe, args, { stdio: "ignore", env: browserEnv() });

    try {
      const port = await waitForDebugPort(portFile, child, 25_000);
      log(`调试端口 ${port}`);
      cdp = await Cdp.connect(port);
      break;
    } catch (e) {
      killTree(child);
      await sleep(300);
      await removeProfile(profileDir); // 启动失败的清理必须等它做完，别留下含登录态的目录
      if (idx < exes.length - 1) {
        log(`浏览器 ${exe} 启动失败（${e?.message ?? e}），尝试备选: ${exes[idx + 1]}`);
        continue;
      }
      throw e;
    }
  }

  let settled = false;
  let cleaned = false;
  let timer = null;
  let readyResolve = null;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    cdp?.detach(); // 不关 ws：见 detach() 的说明
    killTree(child);
    await sleep(600); // 让进程真的死透，再动 profile 目录
    if (!(await removeProfile(profileDir))) {
      log(`临时 profile 没能删掉（不影响登录）：${profileDir}`);
    }
  };

  const result = new Promise((resolve, reject) => {
    const ok = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      void cleanup().finally(() => reject(error instanceof Error ? error : new Error(String(error))));
    };

    (async () => {
      try {
        await cdp.send("Page.enable");
        await cdp.send("Fetch.enable", {
          patterns: [{ urlPattern: `*${callbackHost}*`, requestStage: "Request" }],
        });

        cdp.on((evt) => {
          if (evt.method !== "Fetch.requestPaused") return;
          void onPaused(evt.params, { cdp, expectedState, callbackHost, ok, fail, log });
        });
        cdp.onClose(() => fail(new Error("登录窗口被关闭了")));
        child.once("exit", () => fail(new Error("登录窗口被关闭了")));

        timer = setTimeout(() => fail(new Error("登录超时：没有在浏览器里完成登录")), timeoutMs);
        cdp.send("Page.navigate", { url: authorizeUrl }).catch((e) => log(`导航命令返回: ${e?.message ?? e}`));
      } catch (e) {
        fail(e);
      } finally {
        readyResolve(cdp);
      }
    })();
  });
  result.catch(() => {}); // 用户取消时可能没人 await，这里兜住未处理拒绝

  const navigate = async (url) => {
    const client = await ready;
    if (!client) throw new Error("浏览器没起来，无法导航");
    return client.send("Page.navigate", { url });
  };

  return { result, close: cleanup, navigate, profileDir };
}

async function onPaused(params, ctx) {
  const { cdp, expectedState, callbackHost, ok, fail, log } = ctx;
  const { requestId, request } = params;
  const url = request?.url ?? "";

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {}

  const code = parsed?.searchParams.get("code") ?? "";
  const error = parsed?.searchParams.get("error") ?? "";
  const state = parsed?.searchParams.get("state") ?? "";

  // 不是回调：放行（授权请求本身、页面其它请求都会走到这里）
  if (!parsed || parsed.hostname !== callbackHost || (!code && !error)) {
    void cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
    return;
  }

  if (expectedState && state !== expectedState) {
    log("回调 state 与本会话不匹配，放行并继续等待");
    void cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
    return;
  }

  if (error) {
    const detail = parsed.searchParams.get("error_description") || error;
    await fulfillPage(cdp, requestId, htmlPage("登录没有完成", detail, false));
    fail(new Error(`平台拒绝了这次登录：${detail}`));
    return;
  }

  // 先替换页面（SPA 不执行），再交付 code——fulfill 失败不影响 code 有效性
  await fulfillPage(cdp, requestId, htmlPage("登录成功", "此窗口可以关闭，凭据正在交给 magpie。", true));
  log("已捕获授权码");
  ok({ code, state, redirectUrl: parsed.toString() });
}

async function fulfillPage(cdp, requestId, html) {
  try {
    await cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(html, "utf8").toString("base64"),
    });
  } catch {
    /* 窗口在最后一刻被关掉之类，忽略 */
  }
}
