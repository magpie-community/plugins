// One user message → Codex app-server UserInput items.
// Only PNG / JPEG / GIF / WebP go as localImage; every other attachment (text files included) is named by its
// absolute path in the text, which Codex opens with its own tools. Files that aren't images or text get a warning.
import { basename } from "node:path";
import { resolveImagePath } from "../../util/attachmentRefs.js";
import { attachmentKind, baseMime, pathNote } from "../../util/attachmentKinds.js";

export async function buildCodexInput(
  text: string,
  attachments: { path: string; mime: string }[],
): Promise<{ items: Record<string, unknown>[]; warnings: string[] }> {
  const images: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const a of attachments) {
    let file: string;
    try {
      file = await resolveImagePath(a.path);
    } catch (e) {
      warnings.push(`${a.path}: ${String((e as Error)?.message ?? e)}`);
      continue;
    }
    const kind = attachmentKind(a.mime);
    if (kind === "image") {
      images.push({ type: "localImage", path: file });
      continue;
    }
    notes.push(pathNote(kind, file));
    if (kind === "other") warnings.push(`${basename(file)} (${baseMime(a.mime) || "unknown type"}) is not an image or a text file; sent its path`);
  }
  const fullText = [text, ...(notes.length ? [notes.join("\n")] : [])].filter(Boolean).join("\n\n");
  return { items: [{ type: "text", text: fullText }, ...images], warnings };
}
