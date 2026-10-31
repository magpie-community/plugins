// How each Agent gets an attachment: only PNG/JPEG/GIF/WebP are images; text files are text; the rest go by path.
// Claude Code used to send every attachment (a .txt included) as an image block, and Codex as localImage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentKind, baseMime } from "../../daemon/src/util/attachmentKinds.js";
import { buildClaudeContent, CLAUDE_MAX_IMAGE_BYTES } from "../../daemon/src/providers/claude/content.js";
import { buildCodexInput } from "../../daemon/src/providers/codex/input.js";
import { buildAcpPrompt } from "../../daemon/src/providers/acp/prompt.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let dir: string, png: string, txt: string, svg: string, bin: string;
// what the attachment store gives text uploads
const TEXT = "text/plain; charset=utf-8";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "att-content-"));
  png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  txt = join(dir, "notes.txt");
  writeFileSync(txt, "第一行 notes\n");
  svg = join(dir, "logo.svg");
  writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  bin = join(dir, "blob.bin");
  writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("attachmentKind", () => {
  it("knows the four model image types, text, and the rest", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"]) expect(attachmentKind(m)).toBe("image");
    for (const m of [TEXT, "text/markdown", "application/json"]) expect(attachmentKind(m)).toBe("text");
    for (const m of ["image/svg+xml", "image/bmp", "application/pdf", "application/octet-stream", "", undefined]) expect(attachmentKind(m)).toBe("other");
    expect(baseMime(TEXT)).toBe("text/plain");
  });
});

describe("Claude Code content", () => {
  it("an image is an image block, a text file a plain-text document block, the text last", async () => {
    const r = await buildClaudeContent("look", [{ path: png, mime: "image/png" }, { path: txt, mime: TEXT }]);
    expect(r.blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "第一行 notes\n" }, title: "notes.txt", context: txt },
      { type: "text", text: "look" },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("a text file is never an image block (the old bug)", async () => {
    const r = await buildClaudeContent("", [{ path: txt, mime: TEXT }]);
    expect(r.blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("svg, binaries and images over 5 MB go by path, with a warning", async () => {
    const big = join(dir, "big.png");
    writeFileSync(big, "");
    truncateSync(big, CLAUDE_MAX_IMAGE_BYTES + 1);
    const r = await buildClaudeContent("hi", [
      { path: svg, mime: "image/svg+xml" },
      { path: bin, mime: "application/octet-stream" },
      { path: big, mime: "image/png" },
    ]);
    expect(r.blocks).toEqual([{ type: "text", text: `hi\n\nAttached file: ${svg}\nAttached file: ${bin}\nAttached image: ${big}` }]);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toContain("image/svg+xml");
    expect(r.warnings[2]).toContain("5 MB");
  });

  it("a missing attachment is a warning, not a failed message", async () => {
    const r = await buildClaudeContent("hi", [{ path: join(dir, "gone.png"), mime: "image/png" }]);
    expect(r.blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("Codex input", () => {
  it("only images are localImage; text files and others are paths in the text", async () => {
    const r = await buildCodexInput("look", [
      { path: png, mime: "image/jpeg" },
      { path: txt, mime: TEXT },
      { path: bin, mime: "application/octet-stream" },
    ]);
    expect(r.items).toEqual([
      { type: "text", text: `look\n\nAttached file: ${txt}\nAttached file: ${bin}` },
      { type: "localImage", path: png },
    ]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("blob.bin");
  });

  it("a text-only attachment never becomes localImage (the old bug)", async () => {
    const r = await buildCodexInput("", [{ path: txt, mime: TEXT }]);
    expect(r.items).toEqual([{ type: "text", text: `Attached file: ${txt}` }]);
    expect(r.warnings).toEqual([]);
  });
});

describe("ACP prompt", () => {
  it("an svg is a file by path even for an Agent that takes images", async () => {
    const r = await buildAcpPrompt("", [{ path: svg, mime: "image/svg+xml" }], { image: true, audio: false, embeddedContext: false });
    expect(r.blocks.some((b) => b.type === "image")).toBe(false);
    expect(r.blocks[0]).toEqual({ type: "text", text: `Attached file: ${svg}` });
  });

  it("a text upload (text/plain; charset=utf-8) is embedded with embeddedContext", async () => {
    const r = await buildAcpPrompt("", [{ path: txt, mime: TEXT }], { image: true, audio: false, embeddedContext: true });
    expect(r.blocks).toEqual([{ type: "resource", resource: { uri: expect.stringMatching(/^file:/), mimeType: TEXT, text: "第一行 notes\n" } }]);
  });
});
