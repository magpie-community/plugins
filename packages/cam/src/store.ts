import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openRequestIndex, seenImage } from "../vendor/cam/core/request-index.ts";
import { SESSION_KEY, sessionKeyOf } from "../vendor/cam/core/selection.ts";
import { sessionTitle } from "./session-titles.ts";

export type SessionPolicy = { auto: boolean; pinnedContentIds: string[]; updatedAt?: string; overridesLegacyNative?: boolean };
type LegacyPolicy = Omit<SessionPolicy, "auto"> & { auto?: boolean };
export type SessionInfo = {
  key: string;
  platform: string;
  named: string;
  protocol: string;
  model: string;
  title?: string;
  firstSeen: string;
  lastSeen: string;
};

const DIGEST = /^[0-9a-f]{64}$/;
const JSON_ID = /^[A-Za-z0-9_-]{1,128}$/;

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

export function keyFor(platform: string, named: string): string {
  return sessionKeyOf(`${platform}\n${named}`);
}

const policyFile = (root: string, key: string) => join(root, "policies", `${key}.json`);
const sessionFile = (root: string, key: string) => join(root, "sessions", `${key}.json`);

export function getPolicy(root: string, key: string, automatic = true): SessionPolicy {
  const legacy = getLegacyPolicy(root, key);
  return { ...legacy, auto: legacy.auto ?? automatic };
}

function getLegacyPolicy(root: string, key: string): LegacyPolicy {
  if (!SESSION_KEY.test(key)) return { pinnedContentIds: [] };
  const value = readJson<Partial<SessionPolicy> | null>(policyFile(root, key), null) ?? {};
  return {
    ...(typeof value.auto === "boolean" ? { auto: value.auto } : {}),
    pinnedContentIds: Array.isArray(value.pinnedContentIds) ? [...new Set(value.pinnedContentIds.filter((id) => typeof id === "string" && DIGEST.test(id)))] : [],
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(value.overridesLegacyNative === true ? { overridesLegacyNative: true } : {}),
  };
}

export function getPolicyWithOptions(root: string, key: string, automatic = true, options?: Record<string, unknown>): SessionPolicy {
  return resolvePolicy(getPolicy(root, key, automatic), key, options);
}

function resolvePolicy(base: SessionPolicy, key: string, options?: Record<string, unknown>): SessionPolicy {
  const table = options?.sessionPolicies;
  const candidate = table && typeof table === "object" && !Array.isArray(table) ? (table as Record<string, any>)[key] : null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return base;
  const nativeTime = typeof candidate.updatedAt === "string" ? Date.parse(candidate.updatedAt) : NaN;
  const fileTime = Date.parse(base.updatedAt ?? "");
  if (candidate.version !== 2 && (Number.isFinite(nativeTime) ? fileTime >= nativeTime : base.overridesLegacyNative)) return base;
  return {
    auto: typeof candidate.auto === "boolean" ? candidate.auto : base.auto,
    pinnedContentIds: Array.isArray(candidate.pinnedContentIds) ? [...new Set(candidate.pinnedContentIds.filter((id: unknown) => typeof id === "string" && DIGEST.test(id)))] : base.pinnedContentIds,
    ...(Number.isFinite(nativeTime) ? { updatedAt: candidate.updatedAt } : {}),
  };
}

export function recordSession(root: string, value: Omit<SessionInfo, "firstSeen" | "lastSeen"> & { at?: string; titleSource?: "index" | "query" | null }): void {
  if (!SESSION_KEY.test(value.key) || !JSON_ID.test(value.platform)) return;
  const file = sessionFile(root, value.key);
  const earlier = readJson<Partial<SessionInfo>>(file, {});
  const now = value.at ?? new Date().toISOString();
  const { at: _at, titleSource, ...info } = value;
  const title = titleSource === "index" ? value.title : earlier.title ?? value.title;
  atomicJson(file, { ...info, ...(title ? { title } : {}), firstSeen: earlier.firstSeen ?? now, lastSeen: now });
}

export function listSessions(root: string): SessionInfo[] {
  const dir = join(root, "sessions");
  try {
    return readdirSync(dir).filter((name) => /^[0-9a-f]{32}\.json$|^[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => readJson<SessionInfo | null>(join(dir, name), null))
      .filter((value): value is SessionInfo => !!value && SESSION_KEY.test(value.key) && JSON_ID.test(value.platform))
      .map((value) => {
        const original = sessionTitle(value.platform, value.named).title;
        return original ? { ...value, title: original } : value;
      })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 100);
  } catch { return []; }
}

export function getSession(root: string, key: string): SessionInfo | null {
  if (!SESSION_KEY.test(key)) return null;
  const value = readJson<SessionInfo | null>(sessionFile(root, key), null);
  if (!value || value.key !== key || !JSON_ID.test(value.platform)) return null;
  const original = sessionTitle(value.platform, value.named).title;
  return original ? { ...value, title: original } : value;
}

export function sessionDetail(root: string, key: string, automatic = true, options?: Record<string, unknown>) {
  const session = getSession(root, key);
  if (!session) return null;
  const legacyPolicy = getLegacyPolicy(root, key);
  const policy = resolvePolicy({ ...legacyPolicy, auto: legacyPolicy.auto ?? automatic }, key, options);
  const pinned = new Set(policy.pinnedContentIds);
  const index = openRequestIndex(session.platform, key, root);
  const images = [...index.images.entries()].map(([contentId, seen]) => {
    let storedChars = 0;
    try { storedChars = statSync(join(root, "platforms", session.platform, "images", contentId)).size; } catch { /* gone */ }
    return { contentId, ...seen, pinned: pinned.has(contentId), stored: storedChars > 0 };
  }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { session, policy, legacyPolicy, images };
}

export function imageForPanel(root: string, key: string, id: string): { mime: string; data: string } | null {
  const session = getSession(root, key);
  if (!session || !/^IMG-\d{3,}$/.test(id)) return null;
  const index = openRequestIndex(session.platform, key, root);
  const found = seenImage(index, id, root);
  if (!found?.data) return null;
  return { mime: found.seen.mime ?? "image/png", data: found.data };
}
