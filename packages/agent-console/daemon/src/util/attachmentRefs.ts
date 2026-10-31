import { existsSync } from "node:fs";
import type { AttachmentStore } from "../store/attachments.js";
import { validId } from "./paths.js";
import { tr } from "./i18n.js";

let globalAttachmentStore: AttachmentStore | null = null;

/** Registered at main startup so Providers can resolve upload ids when reading images */
export function bindAttachmentStore(store: AttachmentStore): void {
  globalAttachmentStore = store;
}

async function lookupAttachmentPath(ref: string): Promise<string | null> {
  const store = globalAttachmentStore;
  if (!store || !validId(ref)) return null;
  const att = await store.get(ref);
  return att?.path ?? null;
}

export async function resolveAttachmentRefs(
  store: AttachmentStore,
  refs: { path: string; mime: string }[],
): Promise<{ path: string; mime: string }[]> {
  const out: { path: string; mime: string }[] = [];
  for (const a of refs) {
    const att = validId(a.path) ? await store.get(a.path) : null;
    if (att) {
      out.push({ path: att.path, mime: att.mime || a.mime });
      continue;
    }
    const viaGlobal = await lookupAttachmentPath(a.path);
    if (viaGlobal) {
      out.push({ path: viaGlobal, mime: a.mime });
      continue;
    }
    if (existsSync(a.path)) {
      out.push(a);
      continue;
    }
    throw new Error(tr("attachment.missing", { ref: a.path }));
  }
  return out;
}

/** One path: absolute path / upload id → the file under the attachments directory; throws on failure */
export async function resolveImagePath(ref: string): Promise<string> {
  if (existsSync(ref)) return ref;
  const p = await lookupAttachmentPath(ref);
  if (p) return p;
  throw new Error(tr("attachment.missing", { ref: ref }));
}
