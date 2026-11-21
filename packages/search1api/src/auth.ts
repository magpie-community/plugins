import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processExists } from "./proc.mjs";
import { refreshToken } from "./oauth.ts";
import {
  PROVIDER,
  type Credential,
  type Options,
  type PluginInput,
  type SavedCredential,
  type StoredAuth,
  type StoredOAuth,
} from "./types.ts";

const REFRESH_LEAD = 60_000;
const SAME_SESSION = (a: StoredOAuth, b: StoredOAuth) =>
  a.access === b.access && a.refresh === b.refresh;
const missing = () =>
  new Error(
    "Sign in with `magpie plugin login search1api`, configure apiKey in plugin options, or set SEARCH1API_API_KEY.",
  );

function piece(value: string | undefined): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function valid(auth: unknown): StoredAuth | undefined {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  const a = auth as StoredAuth;
  if (a.type === "api" && typeof a.key === "string" && a.key) return a;
  if (
    a.type === "oauth" &&
    typeof a.access === "string" &&
    a.access &&
    typeof a.refresh === "string" &&
    typeof a.expires === "number" &&
    Number.isFinite(a.expires) &&
    typeof a.clientId === "string" &&
    typeof a.tokenEndpoint === "string" &&
    typeof a.issuer === "string"
  )
    return a;
  return undefined;
}

function hidden(key: string): string {
  return "key:" + createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export class Credentials {
  private readonly authPath: string;
  private readonly lockPath: string;
  private input: PluginInput;
  private options: Options;
  constructor(input: PluginInput, options: Options) {
    this.input = input;
    this.options = options;
    this.authPath = join(input.directory, "plugin-auth.json");
    this.lockPath = join(input.directory, "search1api-refresh.lock");
  }

  private async slots(): Promise<Map<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.authPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        "Magpie's plugin-auth.json cannot be read. Restore it before signing in again.",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Magpie's plugin-auth.json is invalid.");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(
        (key) =>
          (key === PROVIDER || key.startsWith(PROVIDER + "#")) && record[key],
      )
      .sort((a, b) =>
        a === PROVIDER ? -1 : b === PROVIDER ? 1 : a < b ? -1 : a > b ? 1 : 0,
      );
    return new Map<string, unknown>(
      keys.map((key): [string, unknown] => [key, record[key]]),
    );
  }

  async accounts(): Promise<SavedCredential[]> {
    const slots: SavedCredential[] = [];
    for (const [accountKey, value] of await this.slots()) {
      const auth = valid(value);
      if (auth) {
        slots.push({
          kind: "saved",
          id: "saved:" + accountKey,
          accountKey,
          auth,
        });
        continue;
      }
      if (accountKey === PROVIDER)
        throw new Error("Invalid Search1API sign-in. Sign in again in Magpie.");
    }
    return slots;
  }

  private keys(): string[] {
    for (const value of [this.options.apiKey, process.env.SEARCH1API_API_KEY]) {
      const keys = piece(value);
      if (keys.length) return keys;
    }
    return [];
  }

  async candidates(): Promise<Credential[]> {
    const list: Credential[] = this.keys().map((key): Credential => ({
      kind: "key",
      id: hidden(key),
      key,
    }));
    if (list.length) return list;
    const saved = await this.accounts();
    if (!saved.length) throw missing();
    return saved;
  }

  async bearer(credential: Credential, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (credential.kind === "key") return credential.key;
    const auth = credential.auth;
    if (auth.type === "api") return auth.key;
    const oauth =
      auth.expires > 0 && auth.expires - REFRESH_LEAD <= Date.now()
        ? await this.renew(auth, signal, credential.accountKey)
        : auth;
    return oauth.access;
  }

  // A separate lock serializes both tool-triggered and native auth.refresh
  // across Magpie's CLI, gateway and overlapping plugin-host restarts.
  private async lock(signal?: AbortSignal): Promise<() => Promise<void>> {
    await mkdir(this.input.directory, { recursive: true });
    const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
    const started = Date.now();
    while (true) {
      signal?.throwIfAborted();
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(owner);
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            if ((await readFile(this.lockPath, "utf8")) === owner)
              await unlink(this.lockPath);
          } catch {}
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const raw = await readFile(this.lockPath, "utf8");
        const age = Date.now() - (await stat(this.lockPath)).mtimeMs;
        let dead = false;
        try {
          const holder = JSON.parse(raw);
          if (Number.isInteger(holder.pid) && holder.pid > 0) {
            dead = !processExists(holder.pid);
          }
        } catch {}
        if (
          (dead || age > 60_000) &&
          (await readFile(this.lockPath, "utf8")) === raw
        ) {
          await unlink(this.lockPath);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() - started > 20_000)
        throw new Error("Search1API session refresh is busy. Retry shortly.");
      await delay(25, undefined, { signal });
    }
  }

  private async slot(was: StoredOAuth): Promise<string | undefined> {
    const oauth = (await this.accounts()).filter(
      (account): account is SavedCredential & { auth: StoredOAuth } =>
        account.auth.type === "oauth",
    );
    const exact = oauth.find((account) => SAME_SESSION(account.auth, was));
    if (exact) return exact.accountKey;
    const same = oauth.filter(
      (account) =>
        account.auth.issuer === was.issuer &&
        account.auth.tokenEndpoint === was.tokenEndpoint &&
        account.auth.clientId === was.clientId,
    );
    return same.length === 1 ? same[0].accountKey : undefined;
  }

  async renew(
    was: StoredOAuth,
    signal?: AbortSignal,
    accountKey?: string,
  ): Promise<StoredOAuth> {
    const unlock = await this.lock(signal);
    try {
      const key = accountKey ?? (await this.slot(was));
      if (!key) throw missing();
      const find = async () =>
        (await this.accounts()).find((account) => account.accountKey === key)
          ?.auth;
      const now = await find();
      if (now?.type !== "oauth") throw missing();
      if (!SAME_SESSION(now, was)) return now;
      const next = await refreshToken(now, signal);
      // A logout or a new login while the network request was in flight wins.
      const current = await find();
      if (current?.type !== "oauth") throw missing();
      if (!SAME_SESSION(current, now)) return current;
      await this.input.client.auth.set({ path: { id: key }, body: next });
      return next;
    } finally {
      await unlock();
    }
  }
}
