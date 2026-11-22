// The account pool: several imported Quick sessions behind one provider.
//
// A request takes the next healthy account (round-robin). When an account
// fails in a way that says "this account, not this request" — the cookie was
// refused (401/403) or the usage window is exhausted (usage_limit) — the
// turn is retried on the next account until one answers or the pool is out.
// The pool never auto-downgrades a model and never stops on its own: quota
// exhaustion only moves the request to the next account, and says so.
//
// Per-account state (sockets, failure marks) is keyed by accountId, so two
// accounts never share a connection or a cooldown.

// how long an account sits out after a quota/auth failure (ms) — long enough
// to stop hammering, short enough that a manual re-import takes effect fast
export const COOLDOWN_MS = 60_000

export class AccountPool {
  // accounts: array of account states {accountId, cookie, mbtc, …}
  constructor(accounts = [], opts = {}) {
    this.accounts = accounts
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS
    this.now = opts.now ?? (() => Date.now())
    this.rr = 0 // round-robin cursor
    this.healthy = new Map() // accountId -> usable again at (ms epoch)
    this.lastError = new Map() // accountId -> the failure that benched it
  }

  // usable reports whether an account may take a turn now
  usable(account) {
    const until = this.healthy.get(account.accountId) ?? 0
    return this.now() >= until
  }

  // mark benches an account for one cooldown after a pool-level failure
  mark(account, reason) {
    this.healthy.set(account.accountId, this.now() + this.cooldownMs)
    this.lastError.set(account.accountId, String(reason ?? ""))
  }

  clear(account) {
    this.healthy.delete(account.accountId)
    this.lastError.delete(account.accountId)
  }

  // pick returns the next usable account, starting after the last one used.
  // Returns null when every account is benched or the pool is empty.
  pick() {
    const n = this.accounts.length
    for (let i = 0; i < n; i++) {
      const s = this.accounts[(this.rr + i) % n]
      if (!s?.accountId) continue
      if (this.usable(s)) {
        this.rr = (this.rr + i + 1) % n
        return s
      }
    }
    return null
  }

  // report records a turn's outcome: a pool-level failure benches the
  // account, a success clears it
  report(account, ok, reason) {
    if (ok) this.clear(account)
    else this.mark(account, reason)
  }

  // poolLevel says whether a failure should move the turn to the next
  // account (account-scoped) rather than answer the caller
  static poolLevel(message) {
    const m = String(message ?? "")
    return /401|403|refused|usage_limit|expired/i.test(m)
  }

  // summary is the read-only per-account view for the usage panel
  summary() {
    return this.accounts.map((s) => {
      const benchedUntil = this.healthy.get(s.accountId) ?? 0
      return {
        accountId: s.accountId,
        label: s.label ?? s.accountId,
        usable: this.now() >= benchedUntil,
        ...(benchedUntil > this.now() ? { retryInMs: benchedUntil - this.now() } : {}),
        ...(this.lastError.has(s.accountId) ? { lastError: this.lastError.get(s.accountId) } : {}),
      }
    })
  }
}
