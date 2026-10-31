// One user message → the content blocks of a Claude Code SDK user message (Anthropic MessageParam content).
// - PNG / JPEG / GIF / WebP (Base64ImageSource's media types), up to 5 MB each: an image block
// - text files up to 1 MB: a document block with a plain-text source (DocumentBlockParam + PlainTextSource)
// - anything else, or too large: the file's absolute path in the text, which Claude Code can Read; with a warning
//   for files that aren't images or text, so the user knows
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolveImagePath } from "../../util/attachmentRefs.js";
import { attachmentKind, baseMime, pathNote } from "../../util/attachmentKinds.js";

/** Anthropic's per-image limit */
export const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CLAUDE_MAX_TEXT_BYTES = 1024 * 1024;

type ImageMedia = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMedia; data: string } }
  | { type: "document"; source: { type: "text"; media_type: "text/plain"; data: string }; title?: string; context?: string };

export async function buildClaudeContent(
  text: string,
  attachments: { path: string; mime: string }[],
): Promise<{ blocks: ClaudeBlock[]; warnings: string[] }> {
  const media: ClaudeBlock[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const a of attachments) {
    let file: string;
    let size: number;
    try {
      file = await resolveImagePath(a.path);
      size = (await stat(file)).size;
    } catch (e) {
      warnings.push(`${a.path}: ${String((e as Error)?.message ?? e)}`);
      continue;
    }
    const kind = attachmentKind(a.mime);
    try {
      if (kind === "image" && size <= CLAUDE_MAX_IMAGE_BYTES) {
        const data = (await readFile(file)).toString("base64");
        media.push({ type: "image", source: { type: "base64", media_type: baseMime(a.mime) as ImageMedia, data } });
        continue;
      }
      if (kind === "text" && size <= CLAUDE_MAX_TEXT_BYTES) {
        const data = await readFile(file, "utf8");
        media.push({ type: "document", source: { type: "text", media_type: "text/plain", data }, title: basename(file), context: file });
        continue;
      }
    } catch (e) {
      warnings.push(`${basename(file)}: ${String((e as Error)?.message ?? e)}`);
    }
    notes.push(pathNote(kind, file));
    if (kind === "other") warnings.push(`${basename(file)} (${baseMime(a.mime) || "unknown type"}) is not an image or a text file; sent its path`);
    else if (kind === "image" && size > CLAUDE_MAX_IMAGE_BYTES) warnings.push(`${basename(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, over Claude's 5 MB image limit; sent its path`);
    else if (kind === "text" && size > CLAUDE_MAX_TEXT_BYTES) warnings.push(`${basename(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, too large to attach inline; sent its path`);
  }
  const fullText = [text, ...(notes.length ? [notes.join("\n")] : [])].filter(Boolean).join("\n\n");
  // Media first, as before; the text block always comes last (the SDK needs at least one block)
  return { blocks: [...media, { type: "text", text: fullText }], warnings };
}
