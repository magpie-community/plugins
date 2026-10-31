// Turn one user message (text + attachments) into an ACP prompt (ContentBlock[]) for what this Agent accepts.
// - image/* : an image block (base64 + mimeType) when the Agent advertises promptCapabilities.image;
//             otherwise the saved file's absolute path, as a resource_link (ACP baseline) and as a line of text,
//             so an Agent with file tools can still open it; the caller shows a notice that it can't see the image.
// - audio/* : an audio block when promptCapabilities.audio, else the same path fallback.
// - text    : an embedded resource (its text) when promptCapabilities.embeddedContext and small enough, else a path.
// Every attachment is either sent or named by path: nothing is dropped silently.
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveImagePath } from "../../util/attachmentRefs.js";
import type { AcpPromptCaps } from "./promptCaps.js";

/** Largest image / audio sent inline as base64 (above it, the path is sent instead) */
export const MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;
/** All inline media of one prompt together. Base64 adds a third, and an Agent built on the ACP SDK refuses an incoming
 *  line over 32 MB (DEFAULT_MAX_MESSAGE_BYTES), so one prompt stays well under that; the rest goes by path. */
export const MAX_INLINE_TOTAL_BYTES = 16 * 1024 * 1024;
/** Largest text file embedded as a resource */
export const MAX_EMBED_TEXT_BYTES = 1024 * 1024;

export type AcpPromptBuild = {
  blocks: ContentBlock[];
  /** Images that went by path because the Agent doesn't take image blocks */
  imagesByPath: string[];
  /** Other problems worth a notice (unreadable file, too large) */
  warnings: string[];
};

const isText = (mime: string) => mime.startsWith("text/") || mime === "application/json";

export async function buildAcpPrompt(
  text: string,
  attachments: { path: string; mime: string }[],
  caps: AcpPromptCaps,
): Promise<AcpPromptBuild> {
  const media: ContentBlock[] = [];
  const links: ContentBlock[] = [];
  const pathLines: string[] = [];
  const imagesByPath: string[] = [];
  const warnings: string[] = [];
  let inlineBytes = 0;

  const byPath = (file: string, mime: string, size: number | null, label: string) => {
    links.push({ type: "resource_link", uri: pathToFileURL(file).href, name: basename(file), mimeType: mime, ...(size !== null ? { size } : {}) });
    pathLines.push(`${label}: ${file}`);
  };

  for (const a of attachments) {
    const mime = a.mime || "application/octet-stream";
    let file: string;
    let size: number | null = null;
    try {
      file = await resolveImagePath(a.path);
      size = (await stat(file)).size;
    } catch (e) {
      warnings.push(`${a.path}: ${String((e as Error)?.message ?? e)}`);
      continue;
    }
    const image = mime.startsWith("image/");
    const audio = mime.startsWith("audio/");
    if ((image && caps.image) || (audio && caps.audio)) {
      if (size > MAX_INLINE_MEDIA_BYTES || inlineBytes + size > MAX_INLINE_TOTAL_BYTES) {
        const limit = size > MAX_INLINE_MEDIA_BYTES ? MAX_INLINE_MEDIA_BYTES : MAX_INLINE_TOTAL_BYTES;
        warnings.push(`${basename(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, over the ${limit / 1024 / 1024} MB inline limit; sent as a file path`);
        byPath(file, mime, size, image ? "Attached image" : "Attached audio");
        if (image) imagesByPath.push(file);
        continue;
      }
      try {
        const data = (await readFile(file)).toString("base64");
        media.push(image ? { type: "image", data, mimeType: mime } : { type: "audio", data, mimeType: mime });
        inlineBytes += size;
      } catch (e) {
        warnings.push(`${basename(file)}: ${String((e as Error)?.message ?? e)}`);
        byPath(file, mime, size, image ? "Attached image" : "Attached audio");
        if (image) imagesByPath.push(file);
      }
      continue;
    }
    if (image || audio) {
      byPath(file, mime, size, image ? "Attached image" : "Attached audio");
      if (image) imagesByPath.push(file);
      continue;
    }
    if (isText(mime) && caps.embeddedContext && size <= MAX_EMBED_TEXT_BYTES && inlineBytes + size <= MAX_INLINE_TOTAL_BYTES) {
      try {
        const body = await readFile(file, "utf8");
        media.push({ type: "resource", resource: { uri: pathToFileURL(file).href, mimeType: mime, text: body } });
        inlineBytes += size;
        continue;
      } catch {
        /* fall back to the path */
      }
    }
    byPath(file, mime, size, "Attached file");
  }

  const fullText = [text, ...(pathLines.length ? [pathLines.join("\n")] : [])].filter(Boolean).join("\n\n");
  const blocks: ContentBlock[] = [];
  if (fullText) blocks.push({ type: "text", text: fullText });
  blocks.push(...media, ...links);
  return { blocks, imagesByPath, warnings };
}
