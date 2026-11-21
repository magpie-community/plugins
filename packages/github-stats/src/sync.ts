import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  dataDir,
  readConfig,
  jsonFile,
  atomicWrite,
  withLock,
} from "./config.js";
import { resolveToken } from "./credentials.js";
import { GitHub, GitHubError } from "./github.js";
import { readUsage } from "./usage.js";
import { renderCard } from "./renderer.js";
import type { Config, Stats, SyncState } from "./types.js";
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function due(c: Config, s: SyncState, now = new Date()) {
  if (!c.daily) return false;
  if (s.nextRetry && Date.parse(s.nextRetry) > now.getTime()) return false;
  if (s.fingerprint !== hash(JSON.stringify(c)) || !s.lastSuccess) return true;
  if (localDate(new Date(s.lastSuccess)) === localDate(now)) return false;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return (
    now.getHours() >= 2 ||
    localDate(new Date(s.lastSuccess)) < localDate(yesterday)
  );
}
export const readState = (dir = dataDir()) =>
  jsonFile<SyncState>(join(dir, "state.json"), {});
interface Dependencies {
  config?: Config;
  stats?: () => Promise<Stats>;
  github?: GitHub;
  now?: Date;
}
export async function sync(
  dir = dataDir(),
  onlyDue = false,
  dependencies: Dependencies = {},
) {
  return withLock(dir, async () => {
    const c = dependencies.config || (await readConfig(dir)),
      state = await readState(dir),
      now = dependencies.now || new Date();
    if (onlyDue && !due(c, state, now))
      return { result: "skipped", changed: 0 };
    if (state.nextRetry && Date.parse(state.nextRetry) > now.getTime())
      throw new Error(
        `GitHub 限流或失败冷却中，请在 ${state.nextRetry} 后重试。`,
      );
    state.lastAttempt = now.toISOString();
    try {
      const stats = await (dependencies.stats || (() => readUsage(c)))();
      const digest = hash(
        ["light", "dark"]
          .map((mode) =>
            renderCard(stats, c, mode as "light" | "dark", "2000-01-01"),
          )
          .join(""),
      );
      const updated =
        state.publishedDigest === digest && state.publishedDate
          ? state.publishedDate
          : localDate(now);
      const cards = {
        light: renderCard(stats, c, "light", updated),
        dark: renderCard(stats, c, "dark", updated),
      };
      const github =
        dependencies.github || new GitHub(await resolveToken(c, dir));
      const repo = await github.repository(c);
      let changed = 0;
      // Contents writes must be sequential. Each file is a complete valid SVG.
      for (const mode of ["light", "dark"] as const)
        if (await github.put(c, repo.branch, `magpie-${mode}.svg`, cards[mode]))
          changed++;
      for (const mode of ["light", "dark"] as const)
        await atomicWrite(
          join(dir, "cards", `magpie-${mode}.svg`),
          cards[mode],
        );
      Object.assign(state, {
        lastSuccess: now.toISOString(),
        lastResult: changed ? "updated" : "unchanged",
        fingerprint: hash(JSON.stringify(c)),
        publishedDigest: digest,
        publishedDate: updated,
      });
      delete state.error;
      delete state.nextRetry;
      await atomicWrite(
        join(dir, "state.json"),
        JSON.stringify(state, null, 2),
      );
      return {
        result: state.lastResult,
        changed,
        branch: repo.branch,
        private: repo.private,
      };
    } catch (e) {
      // Errors are authored by our adapters; never persist HTTP bodies or tokens.
      state.error = e instanceof Error ? e.message : "同步失败。";
      state.lastResult = "failed";
      state.nextRetry =
        e instanceof GitHubError && e.retryAt
          ? e.retryAt
          : new Date(now.getTime() + 60000).toISOString();
      await atomicWrite(
        join(dir, "state.json"),
        JSON.stringify(state, null, 2),
      );
      throw e;
    }
  });
}
