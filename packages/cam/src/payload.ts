import type { Lang } from "../vendor/cam/core/lang.ts";
import { openRequestIndex, readImageContent } from "../vendor/cam/core/request-index.ts";
import { fetchedLabel } from "../vendor/cam/core/words.ts";
import { IMAGE_ID, isFetchImage, retrievableImage, verifiedContentId, MAX_FETCH_CHARS, type FetchImage } from "./retrieval.ts";

export const PAYLOAD_PREFIX = "MAGPIE_CAM_IMAGE_PAYLOAD_V1:";
export const REFERENCE_PREFIX = "MAGPIE_CAM_IMAGE_PAYLOAD_V2:";
const MAX_REFERENCE_CHARS = 64 * 1024;
const MAX_TEXT_CHARS = 16_384;
const MAX_PARTS = 17;
const MAX_WIRE_CHARS = MAX_FETCH_CHARS + PAYLOAD_PREFIX.length + MAX_PARTS * (MAX_TEXT_CHARS * 6 + 256);

type TextContent = { type: "text"; text: string };
export type PayloadContent = TextContent | FetchImage;
type Payload = { version: 1; content: PayloadContent[] };
type ImageReference = { type: "image_ref"; id: string; contentId: string };
export type ReferenceContent = TextContent | ImageReference;
type FindRequestOriginal = (contentId: string) => string | undefined;
type ResolvedPayload = { content: PayloadContent[]; incomplete: boolean };

const text = (value: unknown): value is TextContent => !!value && typeof value === "object" && (value as PayloadContent).type === "text" && typeof (value as TextContent).text === "string" && (value as TextContent).text.length <= MAX_TEXT_CHARS;

export function encodeReferences(session: string, language: Lang, content: ReferenceContent[]): string {
  return REFERENCE_PREFIX + JSON.stringify({ version: 2, session, language, content });
}

function isPayload(value: string): boolean {
  return value.startsWith(PAYLOAD_PREFIX) || value.startsWith(REFERENCE_PREFIX);
}

function reference(value: unknown): value is ImageReference {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<ImageReference>;
  return part.type === "image_ref" && typeof part.id === "string" && IMAGE_ID.test(part.id)
    && typeof part.contentId === "string" && /^[0-9a-f]{64}$/.test(part.contentId);
}

function resolveReferences(value: string, platform: string, session: string, root: string, findOriginal?: FindRequestOriginal): ResolvedPayload | null {
  if (value.length > MAX_REFERENCE_CHARS) return null;
  try {
    const parsed = JSON.parse(value.slice(REFERENCE_PREFIX.length));
    if (parsed?.version !== 2 || parsed.session !== session || (parsed.language !== "zh" && parsed.language !== "en")) return null;
    const content = parsed.content as ReferenceContent[];
    if (!Array.isArray(content) || content.length > 8 || !content.every((part) => text(part) || reference(part))) return null;
    const index = openRequestIndex(platform, session, root);
    const result: PayloadContent[] = [];
    let incomplete = false;
    let remaining = MAX_FETCH_CHARS;
    for (const part of content) {
      if (part.type === "text") {
        result.push(part);
        continue;
      }
      const seen = index.images.get(part.contentId);
      const verify = (data: string | null | undefined): FetchImage | null => {
        if (!data || !seen) return null;
        const image: FetchImage = { type: "image", id: part.id, data, mimeType: seen.mime ?? "image/png" };
        return verifiedContentId(index, image, remaining) === part.contentId ? image : null;
      };
      const image = seen?.id === part.id
        ? verify(readImageContent(root, platform, part.contentId)) ?? verify(findOriginal?.(part.contentId))
        : null;
      if (!image || !seen) {
        incomplete = true;
        result.push({ type: "text", text: parsed.language === "en" ? `${part.id}: original unavailable; upload it again.` : `${part.id}：原图不可用，请重新上传。` });
        continue;
      }
      remaining -= image.data.length;
      result.push(
        { type: "text", text: fetchedLabel({ id: part.id, name: null, label: null, kind: seen.kind, turn: seen.turn, width: seen.width, height: seen.height }, parsed.language) },
        image,
      );
    }
    return { content: result, incomplete };
  } catch { return null; }
}

function decode(value: string): Payload | null {
  if (!value.startsWith(PAYLOAD_PREFIX) || value.length > MAX_WIRE_CHARS) return null;
  try {
    const parsed = JSON.parse(value.slice(PAYLOAD_PREFIX.length));
    if (parsed?.version !== 1 || !Array.isArray(parsed.content) || parsed.content.length > MAX_PARTS) return null;
    if (!parsed.content.every((part: unknown) => text(part) || isFetchImage(part))) return null;
    return parsed;
  } catch { return null; }
}

// A payload is accepted only when every image still belongs to this session and
// its bytes hash to the content id recorded when the original request was seen.
function trusted(payload: Payload, platform: string, session: string, root: string): Payload | null {
  try {
    const index = openRequestIndex(platform, session, root);
    let remaining = MAX_FETCH_CHARS;
    for (const part of payload.content) {
      if (part.type !== "image") continue;
      if (!retrievableImage(index, part, remaining)) return null;
      remaining -= part.data.length;
    }
    return payload;
  } catch { return null; }
}

function materialized(value: unknown, platform: string, session: string | null, root: string, findOriginal?: FindRequestOriginal): ResolvedPayload | null {
  if (typeof value !== "string" || !session) return null;
  if (value.startsWith(REFERENCE_PREFIX)) return resolveReferences(value, platform, session, root, findOriginal);
  const payload = decode(value);
  const verified = payload && trusted(payload, platform, session, root);
  return verified ? { content: verified.content, incomplete: false } : null;
}

function responsesParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
}

function chatParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
}

function anthropicParts(content: PayloadContent[]) {
  return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
}

export function annotateFetchText(text: string, session: string, toolName: string): string {
  if (!text.includes("cam_view_image")) return text;
  const instruction = text.replaceAll("cam_view_image", () => toolName);
  return /IMG-\d{3,}/.test(instruction)
    ? `${instruction}\n[Magpie CAM session: ${session}] Pass this session value when calling ${toolName}.`
    : instruction;
}

export function redactPayloadsEverywhere(value: unknown): { value: any; count: number } {
  let count = 0;
  const visit = (input: unknown): any => {
    if (typeof input === "string") {
      if (!isPayload(input)) return input;
      count++;
      return "[Magpie CAM: image payload dropped after a processing error]";
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));
    return input;
  };
  return { value: visit(value), count };
}

export type MaterializeResult = { body: Record<string, any>; count: number; restored: number; failedResults: number; restoredReferences: number };

function execReference(output: unknown): string | undefined {
  const headerPattern = /^Script completed\r?\nWall time:? [\d.]+ seconds\r?\nOutput:[ \t]*\r?\n/;
  if (typeof output === "string") {
    const header = headerPattern.exec(output);
    const result = header ? output.slice(header[0].length).trim() : "";
    return result.startsWith(REFERENCE_PREFIX) ? result : undefined;
  }
  if (!Array.isArray(output) || output.length !== 2) return;
  const [header, result] = output;
  if (!["input_text", "output_text", "text"].includes(header?.type) || typeof header.text !== "string"
      || headerPattern.exec(header.text)?.[0] !== header.text) return;
  if (["input_text", "output_text", "text"].includes(result?.type) && typeof result.text === "string" && result.text.startsWith(REFERENCE_PREFIX)) return result.text;
}

// Only tool-output positions are inspected. A user message containing the same
// prefix can never manufacture an image or enter the fetched-copy path.
export function materializeToolPayloads(original: Record<string, any>, protocol: string, platform: string, session: string | null, root: string, findOriginal?: FindRequestOriginal): MaterializeResult {
  let count = 0;
  let restored = 0;
  let failedResults = 0;
  let restoredReferences = 0;
  const body = structuredClone(original);
  const convert = (holder: Record<string, any>, key: string, parts: (content: PayloadContent[]) => unknown) => {
    const original = holder[key];
    const plain = typeof original === "string" ? original : Array.isArray(original) && original.length === 1 && ["text", "input_text", "output_text"].includes(original[0]?.type) && typeof original[0]?.text === "string" ? original[0].text : undefined;
    const raw = (platform === "codex" && protocol === "responses" ? execReference(plain ?? original) : undefined) ?? plain;
    if (!raw || !isPayload(raw)) {
      const containsPayload = (value: unknown) => typeof value === "string" && /(?:^|\r?\n)[ \t]*MAGPIE_CAM_IMAGE_PAYLOAD_V[12]:/.test(value);
      const split = containsPayload(plain) || (Array.isArray(original) && original.some((part) => containsPayload(part?.text)));
      if (split) {
        holder[key] = parts([{ type: "text", text: "[Magpie CAM: split or mixed image payload removed]" }]);
        count++;
        failedResults++;
      }
      return;
    }
    const resolved = materialized(raw, platform, session, root, findOriginal);
    const content = resolved?.content ?? [{ type: "text" as const, text: "[Magpie CAM: unavailable or untrusted image payload removed]" }];
    const images = content.filter((part) => part.type === "image").length;
    restored += images;
    if (raw.startsWith(REFERENCE_PREFIX)) restoredReferences += images;
    if (!images || resolved?.incomplete) failedResults++;
    // Never forward an encoded payload as prompt text, even when validation
    // fails or the client supplied no stable session identity.
    holder[key] = parts(content);
    count++;
  };
  if (protocol === "responses" && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || !["function_call_output", "custom_tool_call_output"].includes(item.type)) continue;
      convert(item, "output", responsesParts);
    }
  } else if (protocol === "chat" && Array.isArray(body.messages)) {
    for (const message of body.messages) if (message?.role === "tool") convert(message, "content", chatParts);
  } else if (protocol === "anthropic" && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) if (block?.type === "tool_result") convert(block, "content", anthropicParts);
    }
  }
  return { body, count, restored, failedResults, restoredReferences };
}
