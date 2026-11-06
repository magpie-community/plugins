/**
 * Small, private, crash-tolerant state kept beside Magpie's plugin data.
 *
 * This file intentionally contains no credentials. Accounts are addressed by a
 * truncated SHA-256 digest of the upstream user id, so diagnostics can tell
 * accounts apart without storing the complete id, its email or a token.
 *
 * @module magpie-atomcode/state
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "./internal.mjs";

export const STATE_FILE_NAME = "atomcode-state.json";
export const STATE_VERSION = 1;
const MAX_STATE_BYTES = 2 << 20;
const DIGEST_RE = /^(?:[a-f0-9]{16}|anonymous)$/;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value, max = 200) => {
  if (typeof value !== "string" || !value) return undefined;
  return redactText(value, max);
};

const finite = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : undefined;
};

const iso = (value) => {
  const at = finite(value, 0);
  return at === undefined ? undefined : new Date(at).toISOString();
};

/** A stable, non-reversible account key. */
export function accountDigest(uid) {
  const value = uid === undefined || uid === null ? "" : String(uid);
  if (!value) return "anonymous";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/** The state file path for a Magpie plugin directory. */
export function stateFilePath(directory) {
  return typeof directory === "string" && directory
    ? join(directory, STATE_FILE_NAME)
    : undefined;
}

function sanitizeModel(model) {
  if (!isObject(model)) return undefined;
  const id = text(model.id, 300);
  const key = text(model.key ?? id, 300);
  if (!id || !key) return undefined;
  const levels = Array.isArray(model.levels)
    ? model.levels
        .filter((level) => typeof level === "string" && level.trim())
        .slice(0, 32)
        .map((level) => text(level, 80))
        .filter(Boolean)
    : [];
  const baseURL = text(model.baseURL, 1000);
  return {
    id,
    key,
    context: finite(model.context, 1) ?? 64_000,
    output: finite(model.output, 1) ?? 32_768,
    levels,
    vision: model.vision === true,
    type: text(model.type, 40) ?? "openai",
    ...(baseURL ? { baseURL } : {}),
  };
}

function sanitizeWindow(window) {
  if (!isObject(window)) return undefined;
  const name = text(window.name, 120);
  const unit = text(window.unit, 24);
  if (!name) return undefined;
  const out = { name };
  for (const key of ["used", "span", "amount", "limit"]) {
    const value = finite(window[key], 0);
    if (value !== undefined) out[key] = value;
  }
  if (unit) out.unit = unit;
  const display = text(window.display, 120);
  if (display) out.display = display;
  const resetSecs = finite(window.resetSecs, 0);
  if (resetSecs !== undefined) out.resetSecs = resetSecs;
  const resetsAt = text(window.resetsAt, 60);
  if (resetsAt) out.resetsAt = resetsAt;
  return out;
}

function sanitizeQuota(quota) {
  if (!isObject(quota)) return undefined;
  const out = {
    plan: text(quota.plan, 200) ?? "AtomCode CodingPlan",
    windows: Array.isArray(quota.windows)
      ? quota.windows.map(sanitizeWindow).filter(Boolean).slice(0, 32)
      : [],
  };
  const until = text(quota.until, 60);
  if (until) out.until = until;
  return out;
}

function sanitizeError(error) {
  if (!isObject(error)) return undefined;
  const category = text(error.category, 64);
  if (!category) return undefined;
  const status = finite(error.status, 100, 599);
  return {
    category,
    message: redactText(error.message ?? "", 240),
    at: iso(error.at) ?? new Date().toISOString(),
    ...(status === undefined ? {} : { status }),
  };
}

function sanitizeSelfCheck(check) {
  if (!isObject(check)) return undefined;
  return {
    ok: check.ok === true,
    at: iso(check.at) ?? new Date().toISOString(),
    ms: finite(check.ms, 0, 60_000) ?? 0,
    checks: {
      signature: check.checks?.signature === true,
      version: check.checks?.version === true,
      configuration: check.checks?.configuration === true,
    },
  };
}

function sanitizeAccount(account) {
  if (!isObject(account)) return undefined;
  const digest = text(account.digest, 64);
  if (!digest || !DIGEST_RE.test(digest)) return undefined;
  const out = { digest };
  const loginSource = text(account.loginSource, 40);
  if (loginSource) out.loginSource = loginSource;

  if (Array.isArray(account.models)) {
    const models = account.models.map(sanitizeModel).filter(Boolean).slice(0, 256);
    if (models.length) {
      out.models = models;
      out.modelSource = text(account.modelSource, 24) ?? "cached";
      out.modelUpdatedAt = iso(account.modelUpdatedAt)
        ?? new Date().toISOString();
    }
  }

  const quota = sanitizeQuota(account.quota);
  if (quota) {
    out.quota = quota;
    out.quotaUpdatedAt = iso(account.quotaUpdatedAt)
      ?? new Date().toISOString();
  }
  const error = sanitizeError(account.lastError);
  if (error) out.lastError = error;
  const selfCheck = sanitizeSelfCheck(account.selfCheck);
  if (selfCheck) out.selfCheck = selfCheck;
  const updatedAt = iso(account.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/** Remove anything outside the documented state schema. */
export function sanitizeState(input) {
  const state = {
    version: STATE_VERSION,
    updatedAt: iso(input?.updatedAt) ?? new Date().toISOString(),
    accounts: Object.create(null),
    versionSource: undefined,
  };

  if (isObject(input?.accounts)) {
    for (const [digest, raw] of Object.entries(input.accounts)) {
      if (!DIGEST_RE.test(digest)) continue;
      const account = sanitizeAccount({ ...raw, digest });
      if (account) state.accounts[digest] = account;
    }
  }

  const version = isObject(input?.versionSource) ? input.versionSource : undefined;
  if (version) {
    const value = text(version.version, 80);
    if (value) {
      state.versionSource = {
        version: value,
        source: text(version.source, 24) ?? "unknown",
        checkedAt: iso(version.checkedAt),
        failedAt: iso(version.failedAt),
      };
    }
  }
  return state;
}

export function emptyState() {
  return sanitizeState({});
}

async function atomicWrite(path, textValue) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(textValue, "utf8");
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
 * A serialized state store. With no `directory` it keeps state in memory and
 * never creates a file, which keeps OpenCode's permissive host shape safe.
 */
export function createStateStore({ directory, onError } = {}) {
  const path = stateFilePath(directory);
  let value;
  let loading;
  let writes = Promise.resolve();

  const report = (error) => {
    try {
      onError?.(error);
    } catch {
      /* reporting is best-effort */
    }
  };

  async function load() {
    if (value) return value;
    if (loading) return loading;
    loading = (async () => {
      if (!path) return (value = emptyState());
      try {
        const raw = await readFile(path);
        if (raw.byteLength > MAX_STATE_BYTES) return (value = emptyState());
        const parsed = JSON.parse(raw.toString("utf8"));
        return (value = sanitizeState(parsed));
      } catch (error) {
        // A missing, truncated or foreign file is not a reason to fail a
        // request. It is replaced by the next successful write.
        if (error?.code !== "ENOENT") report(error);
        return (value = emptyState());
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  async function update(mutator) {
    const run = writes.then(async () => {
      await load();
      const draft = structuredClone(value);
      const next = (await mutator(draft)) ?? draft;
      value = sanitizeState({
        ...next,
        updatedAt: Date.now(),
      });
      if (path) await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    });
    writes = run.catch(report);
    return run;
  }

  function account(draft, digest) {
    const key = DIGEST_RE.test(String(digest ?? "")) ? String(digest) : accountDigest(digest);
    draft.accounts[key] ??= { digest: key };
    return draft.accounts[key];
  }

  async function accountByDigest(digest) {
    const state = await load();
    const key = DIGEST_RE.test(String(digest ?? "")) ? String(digest) : accountDigest(digest);
    return structuredClone(state.accounts[key]);
  }

  return {
    path,
    async read() {
      await load();
      return structuredClone(value);
    },
    async account(digest) {
      return accountByDigest(digest);
    },
    async recordLogin(uid, source) {
      if (!source) return;
      return update((draft) => {
        const current = account(draft, accountDigest(uid));
        current.loginSource = redactText(source, 40);
        current.updatedAt = Date.now();
      }).catch((error) => report(error));
    },
    async recordModels(uid, models, { source = "live" } = {}) {
      if (!Array.isArray(models) || !models.length) return;
      return update((draft) => {
        const current = account(draft, accountDigest(uid));
        current.models = models;
        current.modelSource = source;
        current.modelUpdatedAt = Date.now();
        current.updatedAt = Date.now();
      }).catch((error) => report(error));
    },
    async cachedModels(uid) {
      const current = await accountByDigest(accountDigest(uid));
      return Array.isArray(current?.models) ? structuredClone(current.models) : [];
    },
    async recordQuota(uid, quota) {
      if (!isObject(quota)) return;
      return update((draft) => {
        const current = account(draft, accountDigest(uid));
        current.quota = quota;
        current.quotaUpdatedAt = Date.now();
        current.updatedAt = Date.now();
      }).catch((error) => report(error));
    },
    async cachedQuota(uid) {
      const current = await accountByDigest(accountDigest(uid));
      return current?.quota ? structuredClone(current.quota) : undefined;
    },
    async recordError(uid, error) {
      if (!error?.category) return;
      return update((draft) => {
        const current = account(draft, accountDigest(uid));
        current.lastError = error;
        current.updatedAt = Date.now();
      }).catch((reportError) => report(reportError));
    },
    async recordSelfCheck(uid, check) {
      return update((draft) => {
        const current = account(draft, accountDigest(uid));
        current.selfCheck = check;
        current.updatedAt = Date.now();
      }).catch((error) => report(error));
    },
    async recordSelfCheckForDigest(digest, check) {
      if (!DIGEST_RE.test(String(digest ?? ""))) return;
      return update((draft) => {
        const current = account(draft, digest);
        current.selfCheck = check;
        current.updatedAt = Date.now();
      }).catch((error) => report(error));
    },
    async recordVersion(version) {
      if (!isObject(version) || !version.version) return;
      return update((draft) => {
        draft.versionSource = version;
      }).catch((error) => report(error));
    },
  };
}
