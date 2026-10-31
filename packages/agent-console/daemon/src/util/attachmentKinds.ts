// What an attachment is, for deciding how each Agent gets it.
// Only PNG, JPEG, GIF and WebP are images to the model APIs behind Claude Code, Codex and the ACP Agents
// (Anthropic's Base64ImageSource.media_type is exactly these four); anything else is a file the Agent opens by path.
export const MODEL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type AttachmentKind = "image" | "text" | "other";

/** "text/plain; charset=utf-8" → "text/plain" */
export function baseMime(mime: string | undefined | null): string {
  return String(mime ?? "").split(";")[0].trim().toLowerCase();
}

const TEXT_APP = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript"]);

export function attachmentKind(mime: string | undefined | null): AttachmentKind {
  const m = baseMime(mime);
  if (MODEL_IMAGE_MIMES.has(m)) return "image";
  if (m.startsWith("text/") || TEXT_APP.has(m)) return "text";
  return "other";
}

/** The line an Agent gets for an attachment sent by path */
export function pathNote(kind: AttachmentKind, file: string): string {
  return `${kind === "image" ? "Attached image" : "Attached file"}: ${file}`;
}
