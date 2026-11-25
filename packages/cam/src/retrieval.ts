import { createHash } from "node:crypto";
import type { RequestIndex } from "../vendor/cam/core/request-index.ts";

export const MAX_FETCH_CHARS = 32 * 1024 * 1024;
export const IMAGE_ID = /^IMG-\d{3,16}$/;

export type FetchImage = { type: "image"; id: string; data: string; mimeType: string };

export function fitsImageBudget(data: string, remaining: number): boolean {
  return data.length > 0 && data.length <= Math.min(remaining, MAX_FETCH_CHARS);
}

export function isFetchImage(value: unknown): value is FetchImage {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<FetchImage>;
  return part.type === "image" && typeof part.id === "string" && IMAGE_ID.test(part.id)
    && typeof part.mimeType === "string" && /^image\/[a-z0-9.+-]{1,127}$/i.test(part.mimeType)
    && typeof part.data === "string" && fitsImageBudget(part.data, MAX_FETCH_CHARS);
}

export function verifiedContentId(index: RequestIndex, image: FetchImage, remaining: number, knownDigest?: string): string | null {
  if (!isFetchImage(image) || !fitsImageBudget(image.data, remaining)) return null;
  const digest = knownDigest ?? createHash("sha256").update(image.data).digest("hex");
  const seen = index.images.get(digest);
  return seen?.id === image.id && (seen.mime ?? "image/png") === image.mimeType ? digest : null;
}

export function retrievableImage(index: RequestIndex, image: FetchImage, remaining: number, contentId?: string): boolean {
  return verifiedContentId(index, image, remaining, contentId) !== null;
}
