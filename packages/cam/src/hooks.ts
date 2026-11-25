import { join } from "node:path";
import { formatOf, requestOriginals, rewritePlatformRequest } from "../vendor/cam/adapters/protocols/any.ts";
import { hasUnsafeInteger } from "../vendor/cam/core/engine/transport.ts";
import { setPixelCache } from "../vendor/cam/core/pixels.ts";
import { readImageContent } from "../vendor/cam/core/request-index.ts";
import { writeLiveData } from "./live-data.ts";
import { resolveOptions, type CamOptions } from "./options.ts";
import { annotateFetchText, materializeToolPayloads, redactPayloadsEverywhere } from "./payload.ts";
import { retrievableImage } from "./retrieval.ts";
import { sessionTitle } from "./session-titles.ts";
import { getPolicyWithOptions, keyFor, recordSession } from "./store.ts";

type Json = Record<string, any>;
export type HookContext = {
  protocol?: string;
  path?: string;
  origin?: string;
  agent?: string;
  caller?: { agent?: string };
  session?: string;
  model?: string;
  query?: string;
  options?: Record<string, unknown>;
  state?: Json;
  report?: (code: string, bytes?: number) => void;
};

function isFetchToolName(name: string): boolean {
  return name === "cam_view_image" || name.endsWith("_cam_view_image") || name.endsWith("__cam_view_image") || (/^mcp__.+__cam_view_image$/.test(name) && name.includes("cam"));
}

export function fetchToolName(body: Json): string | null {
  const names: string[] = [];
  const collect = (tool: any) => {
    if (typeof tool?.name === "string") names.push(tool.name);
    if (typeof tool?.function?.name === "string") names.push(tool.function.name);
    for (const declaration of Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : []) collect(declaration);
    for (const nested of Array.isArray(tool?.tools) ? tool.tools : []) collect(nested);
  };
  for (const tool of Array.isArray(body.tools) ? body.tools : []) collect(tool);
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type !== "additional_tools") continue;
    for (const tool of Array.isArray(item.tools) ? item.tools : []) collect(tool);
  }
  return names.find(isFetchToolName) ?? null;
}

export function platformOf(ctx: HookContext): string {
  const raw = String(ctx.caller?.agent || ctx.agent || "other").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return /^[a-z][a-z0-9-]{1,31}$/.test(cleaned) ? cleaned : "other";
}

function namedSession(body: Json, ctx: HookContext): string | null {
  if (ctx.session) return String(ctx.session);
  const metadata = body.client_metadata;
  const raw = metadata?.["x-codex-turn-metadata"];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.thread_id ?? parsed?.session_id ?? metadata?.thread_id ?? null;
  } catch { return metadata?.thread_id ?? null; }
}

function localEnough(ctx: HookContext, options: CamOptions): boolean {
  if (options.allowRemote) return true;
  return ctx.origin === "local" || ctx.origin === "magpie-key";
}

export async function onRequest(body: Json, ctx: HookContext): Promise<Json | undefined> {
  const options = resolveOptions(ctx.options);
  const platform = platformOf(ctx);
  const path = ctx.path ?? "";
  const skip = (code: string) => {
    ctx.report?.(code);
    const redacted = redactPayloadsEverywhere(body);
    return redacted.count ? redacted.value : undefined;
  };
  if (!localEnough(ctx, options) || !formatOf(path) || !body || typeof body !== "object" || Array.isArray(body)) return skip("skipped");
  // Serialize once for change detection and the safe-integer guard. Magpie's
  // hook API provides parsed JSON, so original request bytes are unavailable.
  const originalText = JSON.stringify(body);
  if (hasUnsafeInteger(originalText)) return skip("invalid");
  const named = namedSession(body, ctx);
  const session = named ? keyFor(platform, named) : null;
  const toolName = ctx.protocol === "gemini" ? null : fetchToolName(body);
  let safeBody = body;
  let materializedCount = 0;
  try {
    let originals: Map<string, string> | undefined;
    const materialized = materializeToolPayloads(body, ctx.protocol ?? "", platform, session, options.dataDir,
      (contentId) => (originals ??= requestOriginals(path, body)).get(contentId));
    safeBody = materialized.body;
    materializedCount = materialized.count;
    const policy = session ? getPolicyWithOptions(options.dataDir, session, options.auto, ctx.options) : { auto: options.auto, pinnedContentIds: [] };
    setPixelCache(join(options.dataDir, "cache", "pixels"));
    const rewritten = rewritePlatformRequest(
      platform,
      path,
      Buffer.from(JSON.stringify(materialized.body), "utf8"),
      undefined,
      named,
      options.dataDir,
      options.language,
      // Omission requires both a stable session handle and a usable fetch tool.
      {
        auto: policy.auto && !!toolName && !!named,
        pinnedContentIds: new Set(policy.pinnedContentIds),
        canFetch: (index, contentId, data) => {
          const seen = index.images.get(contentId);
          return !!seen && retrievableImage(index, { type: "image", id: seen.id, data, mimeType: seen.mime ?? "image/png" }, options.maxFetchBytes, contentId)
            && readImageContent(options.dataDir, platform, contentId) === data;
        },
        formatGeneratedText: session && toolName ? (text) => annotateFetchText(text, session, toolName) : undefined,
      },
    );
    const replaced = Array.isArray(rewritten.report.replaced) ? rewritten.report.replaced.length : 0;
    if (rewritten.session && named) {
      try {
        recordSession(options.dataDir, {
          key: rewritten.session,
          platform,
          named,
          protocol: ctx.protocol ?? "",
          model: ctx.model ?? String(body.model ?? ""),
          ...sessionTitle(platform, named, ctx.query),
        });
      } catch (error) {
        if (replaced) throw error;
      }
      try { writeLiveData(options.dataDir); } catch { /* static panel data is best-effort too */ }
    }
    const copies = Array.isArray(rewritten.report.copies) ? rewritten.report.copies.length : 0;
    ctx.state && (ctx.state.cam = { session: rewritten.session, replaced, copies, materialized: materialized.count });
    ctx.report?.(replaced || copies || materialized.count ? "ready" : "skipped", replaced + copies + materialized.count);
    const nextText = rewritten.body.toString("utf8");
    if (!materializedCount && nextText === originalText) return undefined;
    return JSON.parse(nextText);
  } catch {
    // Ordinary requests fail open. A temporary image payload is the exception:
    // it must never fall back to base64 prompt text after a later failure.
    ctx.report?.("unavailable");
    if (materializedCount) return safeBody;
    const redacted = redactPayloadsEverywhere(body);
    return redacted.count ? redacted.value : undefined;
  }
}
