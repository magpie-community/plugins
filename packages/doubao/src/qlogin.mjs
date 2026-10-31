// 豆包扫码登录（移植自 doubao2api qr_login.py 的抓包真值）：
//   1. GET 首页                       → ttwid 等基础 Cookie
//   2. GET /passport/safe/csrf_token  → passport_csrf_token
//   3. GET /passport/web/get_qrcode   → token + base64 PNG 二维码
//   4. 轮询 /passport/web/check_qrconnect（1.5s）→ new / scanned / confirmed / expired
//   5. confirmed 后跟随 redirect_url 链，收集完整 Cookie（含 sessionid）
// 零依赖：fetch + node:zlib（二维码 PNG 解码出 ASCII）。
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng } from "./png.mjs";

const BASE_URL = "https://www.doubao.com";
const AID = "497858";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  Referer: `${BASE_URL}/chat/login`,
  Origin: BASE_URL,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET 一次请求；把响应的 Set-Cookie 合并进 cookies。返回 {status, text}。 */
async function httpGet(url, headers, cookies, { follow = false, timeoutMs = 15_000 } = {}) {
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const resp = await fetch(current, {
      method: "GET",
      headers: { ...headers, ...(Object.keys(cookies).length ? { Cookie: serialize(cookies) } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    mergeSetCookies(resp, cookies);
    if (follow && [301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (location) {
        current = new URL(location, current).href;
        continue;
      }
    }
    return { status: resp.status, text: await resp.text() };
  }
  return { status: 0, text: "" };
}

function serialize(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeSetCookies(resp, cookies) {
  const list = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(";", 1)[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function getJson(url, headers, cookies) {
  const { text } = await httpGet(url, headers, cookies);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把二维码 PNG 解码成终端半块字符画（尽力而为，失败返回 null）。 */
export function qrPngToAscii(png) {
  try {
    const { width, height, data } = decodePng(png);
    if (!width || !height) return null;
    const lum = (x, y) => {
      const i = (y * width + x) * 3;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    const dark = (x, y) => lum(x, y) < 128;
    // 左上静区宽度 ≈ 4 个模块 → 每模块像素数
    let quiet = 0;
    while (quiet < width && !dark(quiet, Math.floor(height / 2))) quiet++;
    // 若从最左列采样撞上黑模块（静区异常），退化为固定 37 模块猜测
    const moduleCount = quiet >= 6 ? Math.round(width / (quiet / 4)) - 8 : 37;
    const scale = width / (moduleCount + 8);
    if (moduleCount < 21 || moduleCount > 177 || scale < 2) return null;
    const sample = (row, col) =>
      dark(
        Math.min(width - 1, Math.floor((col + 4 + 0.5) * scale)),
        Math.min(height - 1, Math.floor((row + 4 + 0.5) * scale)),
      );
    const grid = [];
    for (let r = 0; r < moduleCount; r++) {
      const line = [];
      for (let c = 0; c < moduleCount; c++) line.push(sample(r, c) ? 1 : 0);
      grid.push(line);
    }
    // 半块字符（▀▄█ 空格）保持方形纵横比，外留一圈白边做静区
    const lines = [" ".repeat(moduleCount + 2)];
    for (let r = 0; r < moduleCount; r += 2) {
      let line = " ";
      for (let c = 0; c < moduleCount; c++) {
        const top = grid[r][c];
        const bottom = r + 1 < moduleCount ? grid[r + 1][c] : 0;
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      }
      lines.push(line + " ");
    }
    lines.push(" ".repeat(moduleCount + 2));
    return lines.join("\n");
  } catch {
    return null;
  }
}

/** 保存二维码 PNG 到临时目录并返回路径。 */
export function saveQrPng(png) {
  const file = path.join(tmpdir(), `doubao-login-qr-${Date.now()}.png`);
  writeFileSync(file, png);
  return file;
}

/** 用系统默认看图程序打开文件（Windows explorer / 其他平台 open/xdg-open）。 */
export function openInViewer(file) {
  try {
    if (process.platform === "win32") spawn("explorer.exe", [file], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 完整扫码登录流程。
 * onStatus(stage, detail)：stage ∈ fetching | ready | waiting | scanned | confirmed
 * 返回 { sessionid, ttwid, passport_csrf_token, cookies, qrPng, qrPngPath }。
 */
export async function qrLogin({ onStatus = () => {}, timeoutMs = 180_000, pollMs = 1_500 } = {}) {
  const cookies = {};
  const log = (stage, detail) => onStatus(stage, detail);

  log("fetching", "正在获取二维码…");
  await httpGet(`${BASE_URL}/`, BASE_HEADERS, cookies); // 基础 Cookie（ttwid 等）
  let csrf = cookies.passport_csrf_token || cookies.passport_csrf_token_default || "";
  if (!csrf) {
    const body = await getJson(`${BASE_URL}/passport/safe/csrf_token/?aid=${AID}`, BASE_HEADERS, cookies);
    csrf = body?.data?.passport_csrf_token || cookies.passport_csrf_token || "";
  }

  const next = encodeURIComponent(BASE_URL);
  const qrBody = await getJson(
    `${BASE_URL}/passport/web/get_qrcode/?next=${next}&aid=${AID}`,
    { ...BASE_HEADERS, "x-tt-passport-csrf-token": csrf },
    cookies,
  );
  const qr = qrBody?.data || {};
  const qrErr = qr.error_code ?? qrBody?.error_code ?? -1;
  if (qrErr !== 0 || qrBody?.message !== "success" || !qr.token) {
    throw new Error(`获取二维码失败: ${JSON.stringify(qrBody).slice(0, 200)}`);
  }

  let qrPng = Buffer.alloc(0);
  const b64 = qr.qrcode || qr.qrcode_url || "";
  if (b64.startsWith("data:")) qrPng = Buffer.from(b64.slice(b64.indexOf(",") + 1), "base64");
  else if (/^https?:/.test(b64)) {
    const resp = await fetch(b64, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    qrPng = Buffer.from(await resp.arrayBuffer());
  } else if (b64) qrPng = Buffer.from(b64, "base64");

  log("ready", qrPng.length ? qrPng : null);
  const csrfHeaders = { ...BASE_HEADERS, "x-tt-passport-csrf-token": csrf };

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const body = await getJson(
      `${BASE_URL}/passport/web/check_qrconnect/?next=${next}&token=${encodeURIComponent(qr.token)}&aid=${AID}`,
      csrfHeaders,
      cookies,
    );
    const d = body?.data || {};
    const errCode = d.error_code ?? body?.error_code ?? 0;
    const desc = String(d.description ?? "").toLowerCase();
    if (errCode !== 0 && (desc.includes("expired") || desc.includes("过期"))) {
      throw new Error("二维码已过期，请重新发起登录。");
    }
    const status = d.status || "";
    if (status !== lastStatus) {
      lastStatus = status;
      if (status === "new") log("waiting", "等待扫码");
      if (status === "scanned") log("scanned", "已扫码，请在手机上确认");
    }
    if (status === "confirmed") {
      log("confirmed", "登录成功");
      if (d.redirect_url) await httpGet(d.redirect_url, BASE_HEADERS, cookies, { follow: true, timeoutMs: 20_000 });
      const sessionid = cookies.sessionid || "";
      if (!sessionid) throw new Error("手机已确认登录，但未取到 sessionid，请重试。");
      return {
        sessionid,
        ttwid: cookies.ttwid || "",
        passport_csrf_token: cookies.passport_csrf_token || "",
        cookies: { ...cookies },
        qrPng,
      };
    }
    if (status === "expired") throw new Error("二维码已过期，请重新发起登录。");
    await sleep(pollMs);
  }
  throw new Error("扫码超时（3 分钟），请重新发起登录。");
}

/** 把扫码得到的账号写进插件目录 config.json（同名覆盖，其余字段保留）。 */
function writeAccountToConfig(account, name = "扫码登录") {
  const file = fileURLToPath(new URL("../config.json", import.meta.url));
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* 尚无配置文件 */
  }
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts.filter(Boolean) : [];
  const entry = { name, sessionid: account.sessionid };
  if (account.ttwid) entry.ttwid = account.ttwid;
  if (account.passport_csrf_token) entry.passport_csrf_token = account.passport_csrf_token;
  const idx = accounts.findIndex((a) => a && a.name === name);
  if (idx >= 0) accounts[idx] = entry;
  else accounts.push(entry);
  cfg.accounts = accounts;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return file;
}

export { writeAccountToConfig };
