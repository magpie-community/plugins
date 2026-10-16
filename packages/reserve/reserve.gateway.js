// Routings that keep something in reserve, for a provider's accounts and
// keys or a group's members. magpie offers each as reserve/<name> in every
// routing picker while the plugin is on.
//
// A strategy is given the pool's name, its seats and this plugin's options,
// and returns the order to try the seats in, as indexes. Each seat has key,
// account (a subscription, not an API key), known (its allowance is known),
// used (0–100 of it), soon, pace, weight, resting and tokens. It runs in
// magpie's gateway on moejs: one file, no imports, 20 ms.

// ceiling is the share of an account's allowance past which it waits for
// the others: the options' ceiling, 80 when none is set.
function ceilingOf(options) {
  const c = Number(options && options.ceiling)
  return Number.isFinite(c) && c > 0 && c <= 100 ? c : 80
}

// byTier sorts the indexes by tier, then by more, keeping the listed order
// among those alike.
function byTier(seats, tier, more) {
  return seats
    .map((_, i) => i)
    .sort((a, b) => tier(seats[a]) - tier(seats[b]) || (more ? more(seats[a], seats[b]) : 0) || a - b)
}

export const strategies = {
  // Fill in the order listed, keeping each account's last share: the first
  // one takes requests until it has used `ceiling` percent, then the next.
  // Once every account is past it, the least used goes first. One resting
  // after a failure goes last. A seat whose allowance isn't known (an API
  // key, an account not read yet) counts as below the ceiling.
  ceiling(pool, seats, options) {
    const c = ceilingOf(options)
    const over = (s) => s.known && s.used >= c
    return byTier(
      seats,
      (s) => (s.resting ? 2 : over(s) ? 1 : 0),
      (a, b) => (over(a) && over(b) ? a.used - b.used : 0),
    )
  },

  // Subscriptions before API keys: what is paid for already goes first,
  // and a key that bills by the token only when no account can take the
  // request. Accounts go least used first; keys by their weight, then by
  // what they were sent lately. Resting seats go last.
  "accounts-first"(pool, seats) {
    return byTier(
      seats,
      (s) => (s.resting ? 2 : s.account ? 0 : 1),
      (a, b) => {
        if (a.account && b.account) return (a.known ? a.used : 0) - (b.known ? b.used : 0)
        if (!a.account && !b.account) return (b.weight || 1) - (a.weight || 1) || a.tokens - b.tokens
        return 0
      },
    )
  },
}
