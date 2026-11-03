import { HEADERS, getUrls } from "./endpoints.mjs";

const names = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

const numeric = (value) => {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) {
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
const count = (value) => {
  const n = numeric(value);
  return n !== undefined && n >= 0 ? n : undefined;
};
const format = (value) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

function resetDate(value) {
  if (!value || !["string", "number"].includes(typeof value)) return undefined;
  const timestamp = numeric(value);
  if (timestamp !== undefined) {
    if (timestamp <= 0) return undefined;
    value = timestamp;
  }
  const date = new Date(
    typeof value === "number" && value < 1e11 ? value * 1000 : value,
  );
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseUsage(data) {
  const windows = [];
  const rootReset = resetDate(data.quota_reset_date_utc) ??
    resetDate(data.quota_reset_date) ?? resetDate(data.limited_user_reset_date);
  let balance;
  const plan = typeof data.copilot_plan === "string" ? data.copilot_plan : "";
  const managed = ["business", "enterprise"].includes(plan.toLowerCase());
  const aside = (id, quota) => id === "completions" ||
    id === "premium_interactions" && quota.overage_permitted === true && !managed;
  const snapshots = data.quota_snapshots;
  if (snapshots && typeof snapshots === "object" && !Array.isArray(snapshots)) {
    // Unknown snapshots may describe unrelated allowances and must not gate chat.
    for (const id of Object.keys(names)) {
      const quota = snapshots[id];
      if (!quota || typeof quota !== "object") continue;
      const credits = id === "premium_interactions" &&
        (quota.token_based_billing ?? data.token_based_billing) === true;
      const name = id === "premium_interactions" && credits
        ? "Premium credits" : names[id];
      const resetsAt = resetDate(quota.quota_reset_at) ?? rootReset;
      if (quota.unlimited === true) {
        // A managed pool is labelled unlimited even after it is spent.
        // Chat/completions may say has_quota=false while still unlimited.
        if (id === "premium_interactions" && quota.has_quota === false) {
          windows.push({ name, used: 100, resetsAt, span: 2592000, aside: aside(id, quota) });
          continue;
        }
        const creditsUsed = credits ? count(quota.credits_used) : undefined;
        windows.push({
          name, used: 0, aside: true,
          display: creditsUsed !== undefined
            ? `${format(creditsUsed)} credits used` : "Unlimited",
        });
        continue;
      }
      const limit = count(quota.entitlement);
      // has_quota is not the existence of an allowance: GitHub returns false
      // for exhausted seats, and for usable token-billed seats too (#1063).
      if (limit === 0) continue;
      // New credit billing retains an integer `remaining` alongside the
      // more precise `quota_remaining`; never round away fractional credits.
      const remaining = count(quota.quota_remaining) ?? count(quota.remaining);
      const percentRemaining = numeric(quota.percent_remaining);
      const amount = limit !== undefined && remaining !== undefined
        ? Math.max(0, limit - remaining) : undefined;
      let used = limit > 0 && amount !== undefined ? amount / limit * 100 : undefined;
      if (used === undefined && percentRemaining !== undefined) {
        used = Math.max(0, 100 - percentRemaining);
      }
      if (used === undefined) continue;
      used = Math.min(100, used);
      const unit = credits ? "credits" : "requests";
      const display = [
        amount !== undefined && limit !== undefined
          ? `${format(amount)} / ${format(limit)} ${unit} used` : undefined,
        remaining !== undefined ? `${format(remaining)} ${unit} remaining` : undefined,
      ].filter(Boolean).join("; ");
      const window = {
        name, used,
        resetsAt,
        ...(display ? { display } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(limit !== undefined && amount !== undefined ? { limit } : {}),
        unit, span: 2592000, aside: aside(id, quota),
      };
      windows.push(window);
      if (id === "premium_interactions" && remaining !== undefined) {
        balance = `${format(remaining)} ${unit} remaining`;
      }
    }
  } else if (data.monthly_quotas && data.limited_user_quotas) {
    for (const [id, label] of [["chat", "Chat"], ["completions", "Completions"]]) {
      const limit = count(data.monthly_quotas[id]);
      const remaining = count(data.limited_user_quotas[id]);
      if (!(limit > 0) || remaining === undefined) continue;
      const amount = Math.max(0, limit - remaining);
      windows.push({
        name: label, used: amount / limit * 100, amount, limit, unit: "requests",
        resetsAt: rootReset, span: 2592000, aside: id === "completions",
        display: `${format(amount)} / ${format(limit)} requests used; ${format(remaining)} requests remaining`,
      });
    }
  }
  return {
    ...(typeof data.copilot_plan === "string" ? { plan: data.copilot_plan } : {}),
    ...(typeof data.login === "string" ? { user: data.login } : {}),
    ...(balance ? { balance } : {}),
    windows,
    signIn: "kept",
    ...(!windows.length ? { error: "GitHub did not return readable Copilot quota data" } : {}),
  };
}

export async function readUsage(getAuth) {
  try {
    const auth = await getAuth();
    if (auth?.type !== "oauth" || !auth.refresh) {
      return { windows: [], error: "No GitHub OAuth sign-in is available", signIn: "kept" };
    }
    // This endpoint uses the GitHub OAuth token, not the short-lived
    // Copilot inference token. It works on the account's own GHE host too.
    const response = await fetch(getUrls(auth.enterpriseUrl).USER_URL, {
      headers: {
        ...HEADERS,
        Accept: "application/json",
        Authorization: `token ${auth.refresh}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return {
        windows: [],
        error: `GitHub Copilot quota request failed (HTTP ${response.status})`,
        signIn: response.status === 401 ? "expired" : "kept",
      };
    }
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid quota response");
    }
    // GitHub took the OAuth token, the sign-in that renews the inference
    // token: an account magpie marked for a dropped inference token (an
    // idle slot, plugins#618) is signed in, whatever the quota says.
    return { ...parseUsage(data), signIn: "renewed" };
  } catch {
    // Never include request headers, OAuth tokens or response bodies in errors.
    return {
      windows: [], error: "Unable to read GitHub Copilot quota; retry later",
      signIn: "kept",
    };
  }
}
