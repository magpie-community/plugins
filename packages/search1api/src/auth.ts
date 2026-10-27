import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { refreshToken } from "./oauth.ts";
import {
  PROVIDER,
  type Options,
  type PluginInput,
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

  async stored(): Promise<StoredAuth | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.authPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
    const auth = (value as Record<string, unknown>)[PROVIDER];
    if (!auth) return undefined;
    if (typeof auth !== "object")
      throw new Error("Invalid Search1API sign-in. Sign in again in Magpie.");
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
    throw new Error("Invalid Search1API sign-in. Sign in again in Magpie.");
  }

  async token(
    signal?: AbortSignal,
  ): Promise<{ token: string; oauth?: StoredOAuth }> {
    signal?.throwIfAborted();
    const override =
      this.options.apiKey?.trim() || process.env.SEARCH1API_API_KEY?.trim();
    if (override) return { token: override };
    const auth = await this.stored();
    if (auth?.type === "api") return { token: auth.key };
    if (auth?.type !== "oauth") throw missing();
    const oauth =
      auth.expires > 0 && auth.expires - REFRESH_LEAD <= Date.now()
        ? await this.renew(auth, signal)
        : auth;
    return { token: oauth.access, oauth };
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
            try {
              process.kill(holder.pid, 0);
            } catch (error) {
              dead = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
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

  async renew(was: StoredOAuth, signal?: AbortSignal): Promise<StoredOAuth> {
    const unlock = await this.lock(signal);
    try {
      const now = await this.stored();
      if (now?.type !== "oauth") throw missing();
      if (!SAME_SESSION(now, was)) return now;
      const next = await refreshToken(now, signal);
      // A logout or a new login while the network request was in flight wins.
      const current = await this.stored();
      if (current?.type !== "oauth") throw missing();
      if (!SAME_SESSION(current, now)) return current;
      await this.input.client.auth.set({ path: { id: PROVIDER }, body: next });
      return next;
    } finally {
      await unlock();
    }
  }
}
