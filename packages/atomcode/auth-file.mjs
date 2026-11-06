/**
 * Read and update the sign-in AtomCode's own CLI keeps in
 * `~/.atomcode/auth.toml`.
 *
 * This is deliberately a narrow TOML reader, not a general parser: the file is
 * owned by the official client, so unknown lines and sections are preserved
 * whenever the plugin writes a renewed token back.
 *
 * @module magpie-atomcode/auth-file
 */

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT_KEYS = new Set(["access_token", "refresh_token", "created_at", "expires_in"]);
const USER_KEYS = new Set(["id", "username", "name", "email", "avatar_url"]);

export function defaultAuthFilePath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".atomcode", "auth.toml");
}

/**
 * Resolve a user-supplied CLI auth path.
 *
 * Empty means the default. Only `~`, `~/...` and absolute paths are accepted;
 * relative paths and `~other-user` would make the account source depend on the
 * host's working directory, so they are rejected.
 *
 * @param {unknown} value
 * @param {object} [env]
 * @returns {string}
 */
export function resolveAuthFilePath(value, env = process.env) {
  const raw = value === undefined || value === null ? "" : String(value).trim();
  if (!raw) return defaultAuthFilePath(env);
  if (raw.includes("\0")) throw new Error("AtomCode auth file path contains a NUL byte");
  if (raw.length > 4096) throw new Error("AtomCode auth file path is too long");

  const home = env.HOME || env.USERPROFILE || homedir();
  let resolved;
  if (raw === "~") {
    resolved = home;
  } else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    resolved = join(home, raw.slice(2));
  } else if (raw.startsWith("~")) {
    throw new Error("AtomCode auth file path must not use ~another-user");
  } else if (isAbsolute(raw)) {
    resolved = normalize(raw);
  } else {
    throw new Error("AtomCode auth file path must be absolute or start with ~/");
  }
  if (resolved.length > 4096) throw new Error("AtomCode auth file path is too long");
  return resolved;
}

function splitComment(raw) {
  const text = String(raw ?? "");
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === '"' && escaped) {
      escaped = false;
    } else if (quote === '"' && char === "\\") {
      escaped = true;
    } else if (quote && char === quote) {
      quote = "";
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && char === "#") {
      const value = text.slice(0, i);
      const end = value.trimEnd().length;
      return { value: value.slice(0, end), comment: text.slice(end) };
    }
  }
  return { value: text, comment: "" };
}

function scalar(raw) {
  const value = splitComment(raw).value.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function collect(text) {
  const root = {};
  const user = {};
  let section = "";
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const pair = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/);
    if (!pair) continue;
    const key = pair[1];
    if ((!section && ROOT_KEYS.has(key)) || (section === "user" && USER_KEYS.has(key))) {
      (section === "user" ? user : root)[key] = scalar(pair[2]);
    }
  }
  return { root, user };
}

/**
 * Parse the fields this plugin needs from AtomCode's auth.toml.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseAuthFile(text) {
  const { root, user } = collect(text);
  const access = typeof root.access_token === "string" ? root.access_token : "";
  const uid = user.id === undefined || user.id === null ? "" : String(user.id);
  if (!access) throw new Error("AtomCode auth.toml has no access token");
  if (!uid) throw new Error("AtomCode auth.toml has no user id");

  const createdAt = Number(root.created_at);
  const expiresIn = Number(root.expires_in);
  const expires =
    Number.isFinite(createdAt) && Number.isFinite(expiresIn) && expiresIn > 0
      ? (createdAt + expiresIn) * 1000
      : undefined;
  const email = typeof user.email === "string" && user.email ? user.email : undefined;
  const username = typeof user.username === "string" && user.username ? user.username : undefined;
  const name =
    typeof user.name === "string" && user.name ? user.name : username;

  return {
    type: "oauth",
    source: "atomcode-cli",
    access,
    ...(typeof root.refresh_token === "string" && root.refresh_token
      ? { refresh: root.refresh_token }
      : {}),
    ...(expires !== undefined ? { expires } : {}),
    uid,
    accountId: email || username || uid,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function scalarKind(raw) {
  const text = splitComment(raw).value.trim();
  if (text.startsWith('"') || text.startsWith("'")) return "string";
  if (text === "true" || text === "false") return "boolean";
  const numeric = text.replaceAll("_", "");
  if (/^[+-]?\d+$/.test(numeric)) return "integer";
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(numeric)) {
    return "float";
  }
  return "string";
}

function tomlValue(key, value, existing) {
  if (existing !== undefined) {
    const kind = scalarKind(existing);
    if (kind === "integer") {
      const number = Number(value);
      return Number.isInteger(number) ? String(number) : tomlString(value);
    }
    if (kind === "float") {
      const number = Number(value);
      if (!Number.isFinite(number)) return tomlString(value);
      const text = String(number);
      return /[.eE]/.test(text) ? text : `${text}.0`;
    }
    if (kind === "boolean") {
      return value === true || String(value).toLowerCase() === "true"
        ? "true"
        : "false";
    }
    return tomlString(value);
  }
  if (key === "created_at" || key === "expires_in") {
    const number = Number(value);
    if (Number.isInteger(number)) return String(number);
  }
  return tomlString(value);
}

/**
 * Return auth.toml text with only known credential lines changed.
 *
 * @param {string} text
 * @param {object} next
 * @returns {string}
 */
export function renderAuthFile(text, next) {
  const current = collect(text);
  const rootValues = {
    access_token: next.access,
    refresh_token: next.refresh,
    created_at: next.createdAt,
    expires_in: next.expiresIn,
  };
  const user = { ...current.user, ...(next.user ?? {}) };
  const userValues = Object.fromEntries(Object.entries(user).filter(([key]) => USER_KEYS.has(key)));
  const wanted = { "": rootValues, user: userValues };
  const remaining = {
    "": new Set(Object.entries(rootValues).filter(([, value]) => value !== undefined).map(([key]) => key)),
    user: new Set(Object.entries(userValues).filter(([, value]) => value !== undefined).map(([key]) => key)),
  };

  const eol = String(text).includes("\r\n") ? "\r\n" : "\n";
  const lines = String(text).split(/\r?\n/);
  const output = [];
  let section = "";

  const appendMissing = () => {
    for (const key of remaining[section] ?? []) {
      const value = wanted[section]?.[key];
      if (value !== undefined) output.push(`${key} = ${tomlValue(key, value)}`);
      remaining[section]?.delete(key);
    }
  };

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      appendMissing();
      section = header[1].trim() === "user" ? "user" : header[1].trim();
      output.push(line);
      continue;
    }
    const pair = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*=\s*)(.*)$/);
    if (pair && wanted[section] && remaining[section]?.has(pair[2])) {
      const value = wanted[section][pair[2]];
      if (value !== undefined) {
        const { comment } = splitComment(pair[4]);
        output.push(
          `${pair[1]}${pair[2]}${pair[3]}${tomlValue(pair[2], value, pair[4])}${comment}`,
        );
      } else {
        output.push(line);
      }
      remaining[section].delete(pair[2]);
      continue;
    }
    output.push(line);
  }
  appendMissing();
  if (remaining.user?.size) {
    output.push("[user]");
    for (const key of remaining.user) {
      const value = userValues[key];
      if (value !== undefined) output.push(`${key} = ${tomlValue(key, value)}`);
    }
  }
  return output.join(eol);
}

async function inspect(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("AtomCode CLI is not signed in on this computer");
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("AtomCode auth.toml must be a regular file, not a symlink");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("AtomCode auth.toml permissions are wider than 0600");
  }
  return info;
}

/**
 * Read and validate the CLI's auth file.
 *
 * @param {string} [path]
 * @returns {Promise<object & {path: string, mtimeMs: number}>}
 */
export async function readAuthFile(path = defaultAuthFilePath()) {
  const info = await inspect(path);
  const text = await readFile(path, "utf8");
  return { ...parseAuthFile(text), path, mtimeMs: info.mtimeMs };
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Atomically renew the CLI's credentials while preserving unrelated lines.
 *
 * @param {string} path
 * @param {object} next
 * @returns {Promise<object>}
 */
export async function writeAuthFile(path, next) {
  await inspect(path);
  const currentText = await readFile(path, "utf8");
  parseAuthFile(currentText);
  const createdAt = Number.isFinite(next.createdAt)
    ? Math.floor(next.createdAt)
    : Math.floor(Date.now() / 1000);
  const expiresIn = Number(next.expiresIn);
  if (!next.access || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("refusing to write incomplete AtomCode credentials");
  }
  const text = renderAuthFile(currentText, {
    access: next.access,
    ...(next.refresh ? { refresh: next.refresh } : {}),
    createdAt,
    expiresIn: Math.floor(expiresIn),
    user: next.user,
  });
  parseAuthFile(text);
  await atomicWrite(path, text);
  return readAuthFile(path);
}
