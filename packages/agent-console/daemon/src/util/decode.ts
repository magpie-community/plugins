// 1.3: decoding raw process output (stderr tails, probe output, the no-PTY terminal) that may be UTF-8 or, on Windows,
// the system code page (GBK on Chinese Windows: cmd.exe, PowerShell 5 errors, older tools, Python with a legacy locale…).
// Per chunk: valid UTF-8 stays UTF-8; otherwise it is decoded with the code page. Streaming-safe: at most 3 trailing bytes
// of a multibyte character split across chunks are held back for the next chunk (bounded, never more).
// Protocol stdout (JSON-RPC / stream-json) is always strict UTF-8 and doesn't go through here. node-pty / ConPTY already
// hands out UTF-8, so the PTY terminal doesn't either.
import { spawnSync } from "node:child_process";

/** Windows code page → WHATWG encoding label (Node's TextDecoder with full ICU, the default build since Node 13) */
const CP: Record<number, string> = {
  936: "gbk", 54936: "gb18030", 950: "big5", 932: "shift_jis", 949: "euc-kr", 866: "ibm866", 874: "windows-874",
  1250: "windows-1250", 1251: "windows-1251", 1252: "windows-1252", 1253: "windows-1253", 1254: "windows-1254",
  1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257", 1258: "windows-1258",
  // 437/850 (OEM, Western) have no WHATWG decoder; output there is almost always ASCII or already UTF-8
};

export function codePageLabel(cp: number): string | null {
  const label = CP[cp];
  if (!label) return null;
  try { new TextDecoder(label); return label; } catch { return null; } // small-icu builds: no legacy decoders
}

/** Fallback when the code page can't be read: guess from the locale */
export function labelForLocale(locale: string): string | null {
  const l = locale.toLowerCase();
  if (/^zh[-_](tw|hk|mo|hant)/.test(l)) return codePageLabel(950);
  if (l.startsWith("zh")) return codePageLabel(936);
  if (l.startsWith("ja")) return codePageLabel(932);
  if (l.startsWith("ko")) return codePageLabel(949);
  return null;
}

/** Parse `reg query …\Nls\CodePage /v ACP` or `chcp` output ("Active code page: 936", "活动代码页: 936") */
export function parseCodePage(out: string): number | null {
  const m = /ACP\s+REG_SZ\s+(\d{3,5})/i.exec(out) ?? /:\s*(\d{3,5})\s*$/m.exec(out.trim());
  return m ? Number(m[1]) : null;
}

let systemLabel: string | null | undefined;

/** The legacy encoding to try for non-UTF-8 output: Windows only (ANSI code page, what programs use for pipes); null elsewhere */
export function systemLegacyEncoding(platform: NodeJS.Platform = process.platform): string | null {
  if (systemLabel !== undefined) return systemLabel; // cached (or set by a test)
  if (platform !== "win32") return null;
  let cp: number | null = null;
  try {
    const r = spawnSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { encoding: "latin1", timeout: 2000, windowsHide: true });
    cp = parseCodePage(String(r.stdout ?? ""));
  } catch {}
  if (cp === 65001) return (systemLabel = null); // "Beta: use UTF-8 worldwide": everything is UTF-8 already
  systemLabel = (cp && codePageLabel(cp)) || labelForLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  return systemLabel;
}

/** Test hook */
export function _setSystemLegacyEncoding(label: string | null | undefined): void { systemLabel = label; }

/** Length of an incomplete UTF-8 sequence at the end of b (0–3) */
function utf8Tail(b: Uint8Array): number {
  for (let k = 1; k <= Math.min(3, b.length); k++) {
    const c = b[b.length - k]!;
    if ((c & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > k ? k : 0;
  }
  return 0;
}

/** Length of an incomplete double-byte (or GB18030 four-byte) character at the end of b (0–3) */
function legacyTail(b: Uint8Array, label: string): number {
  const dbcs = label === "gbk" || label === "gb18030" || label === "big5" || label === "euc-kr" || label === "shift_jis";
  if (!dbcs) return 0;
  const gb = label === "gbk" || label === "gb18030";
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    let n = 1;
    if (label === "shift_jis") n = (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc) ? 2 : 1;
    else if (c >= 0x81 && c <= 0xfe) n = gb && i + 1 < b.length && b[i + 1]! >= 0x30 && b[i + 1]! <= 0x39 ? 4 : 2;
    if (i + n > b.length) return b.length - i;
    i += n;
  }
  return 0;
}

/** Does b (valid UTF-8) contain any 3- or 4-byte sequence? (Strong UTF-8 evidence: CJK text in UTF-8 is 3 bytes.) */
function hasLongUtf8(b: Uint8Array): boolean {
  for (const c of b) if (c >= 0xe0) return true;
  return false;
}
function isAscii(b: Uint8Array): boolean {
  for (const c of b) if (c >= 0x80) return false;
  return true;
}

export class OutputDecoder {
  private pending: Uint8Array = new Uint8Array(0);
  private legacyLast = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private readonly lenient = new TextDecoder("utf-8");
  private readonly legacy: TextDecoder | null;

  /** legacy: encoding label for non-UTF-8 chunks; default = the system code page on Windows, none elsewhere */
  constructor(legacy: string | null = systemLegacyEncoding()) {
    let d: TextDecoder | null = null;
    if (legacy) try { d = new TextDecoder(legacy); } catch {}
    this.legacy = d;
  }

  write(chunk: Uint8Array | string): string {
    if (typeof chunk === "string") return chunk;
    let b: Uint8Array = chunk;
    if (this.pending.length) {
      const m = new Uint8Array(this.pending.length + chunk.length);
      m.set(this.pending); m.set(chunk, this.pending.length);
      b = m;
      this.pending = new Uint8Array(0);
    }
    if (!b.length) return "";
    const ut = utf8Tail(b);
    const head = b.subarray(0, b.length - ut);
    let text: string | null = null;
    try { text = this.utf8.decode(head); } catch {}
    if (text !== null) {
      // Valid UTF-8. Right after a code-page chunk, a chunk whose only non-ASCII bytes are 2-byte pairs is far more likely
      // the same program's GBK (e.g. "C4 A1") than Latin/Cyrillic UTF-8, so it sticks with the code page.
      const ascii = isAscii(head);
      if (!(this.legacy && this.legacyLast && !ascii && !hasLongUtf8(head))) {
        if (!ascii) this.legacyLast = false;
        this.pending = b.slice(b.length - ut);
        return text;
      }
    }
    if (!this.legacy) {
      // Not Windows (or no legacy decoder): lenient UTF-8, keeping a split character for the next chunk
      this.pending = b.slice(b.length - ut);
      return this.lenient.decode(head);
    }
    this.legacyLast = true;
    const lt = legacyTail(b, this.legacy.encoding);
    this.pending = b.slice(b.length - lt);
    return this.legacy.decode(b.subarray(0, b.length - lt));
  }

  /** Flush whatever is held back (a truncated character at the very end becomes U+FFFD) */
  end(): string {
    const b = this.pending;
    this.pending = new Uint8Array(0);
    if (!b.length) return "";
    return (this.legacyLast && this.legacy ? this.legacy : this.lenient).decode(b);
  }
}

/** One-shot decode of a whole buffer (probe output, a collected stderr) */
export function decodeOutput(buf: Uint8Array, legacy?: string | null): string {
  const d = new OutputDecoder(legacy === undefined ? systemLegacyEncoding() : legacy);
  return d.write(buf) + d.end();
}
