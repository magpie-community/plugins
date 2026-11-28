import type { Credentials } from "./auth.ts";
import { APIError, AuthenticationError } from "./request.ts";
import type { Credential, StoredOAuth } from "./types.ts";

const SWITCHABLE = new Set([401, 402, 403, 429]);
const DEFAULT_REST = 600_000;
const REST = new Map<number, number>([
  [401, 600_000],
  [402, 600_000],
  [403, 600_000],
  [429, 60_000],
]);
const MIN_REST = 1_000;
const MAX_REST = 3_600_000;

export function restedUntil(
  status: number,
  retryAfter: string | undefined,
  now: number,
): number {
  let wait: number | undefined;
  const text = (retryAfter ?? "").trim();
  if (/^\d+$/.test(text)) wait = Number(text) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) wait = at - now;
  }
  const rest = wait ?? REST.get(status) ?? DEFAULT_REST;
  return now + Math.min(Math.max(rest, MIN_REST), MAX_REST);
}

function refused(error: unknown): boolean {
  return error instanceof APIError && SWITCHABLE.has(error.status);
}

function expired(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { signIn?: unknown }).signIn === "expired"
  );
}

type Attempt<T> =
  | { done: true; value: T }
  | { done: false; error: unknown };

export class Pool {
  private readonly credentials: Credentials;
  private readonly pick: "order" | "rotate";
  private readonly rested = new Map<string, number>();
  private turn = 0;

  constructor(credentials: Credentials, pick: "order" | "rotate") {
    this.credentials = credentials;
    this.pick = pick;
  }

  private order(list: Credential[], now: number): Credential[] {
    const ready: Credential[] = [];
    const cooling: Credential[] = [];
    for (const credential of list) {
      if ((this.rested.get(credential.id) ?? 0) > now) cooling.push(credential);
      else ready.push(credential);
    }
    cooling.sort(
      (a, b) => (this.rested.get(a.id) ?? 0) - (this.rested.get(b.id) ?? 0),
    );
    if (this.pick !== "rotate") return [...ready, ...cooling];
    const start = ready.length ? this.turn++ % ready.length : 0;
    return [...ready.slice(start), ...ready.slice(0, start), ...cooling];
  }

  private async attempt<T>(
    credential: Credential,
    call: (token: string) => Promise<T>,
    signal: AbortSignal,
  ): Promise<Attempt<T>> {
    let token: string;
    try {
      token = await this.credentials.bearer(credential, signal);
    } catch (error) {
      return { done: false, error };
    }
    try {
      return { done: true, value: await call(token) };
    } catch (error) {
      if (!(error instanceof AuthenticationError)) return { done: false, error };
      if (credential.kind !== "saved" || credential.auth.type !== "oauth")
        return { done: false, error };
      const renewed = await this.credentials
        .renew(credential.auth, signal, credential.accountKey)
        .then(
          (next): Attempt<StoredOAuth> => ({ done: true, value: next }),
          (error): Attempt<StoredOAuth> => ({ done: false, error }),
        );
      if (!renewed.done) return { done: false, error: renewed.error };
      try {
        return { done: true, value: await call(renewed.value.access) };
      } catch (retry) {
        return { done: false, error: retry };
      }
    }
  }

  async send<T>(
    call: (token: string) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const ordered = this.order(await this.credentials.candidates(), Date.now());
    let last: unknown = new Error("Search1API has no usable credential.");
    for (let index = 0; index < ordered.length; index++) {
      signal.throwIfAborted();
      const credential = ordered[index];
      const result = await this.attempt(credential, call, signal);
      if (result.done) {
        this.rested.delete(credential.id);
        return result.value;
      }
      last = result.error;
      if (!(refused(result.error) || expired(result.error)))
        throw result.error;
      const status = result.error instanceof APIError ? result.error.status : 401;
      const after =
        result.error instanceof APIError ? result.error.retryAfter : undefined;
      this.rested.set(credential.id, restedUntil(status, after, Date.now()));
      if (index + 1 === ordered.length) throw result.error;
    }
    throw last;
  }
}
