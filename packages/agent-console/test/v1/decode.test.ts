// 1.3 item 3: UTF-8 vs GBK (system code page) decoding of raw process output
import { describe, it, expect, afterEach } from "vitest";
import { OutputDecoder, decodeOutput, parseCodePage, codePageLabel, labelForLocale, systemLegacyEncoding, _setSystemLegacyEncoding } from "../../daemon/src/util/decode.js";

const hex = (h: string) => Buffer.from(h.replace(/\s+/g, ""), "hex");
// GBK fixtures (encoded with Python's gbk codec)
const GBK_HELLO = hex("c4e3bac3a3accac0bde7"); // 你好，世界
const GBK_NOPATH = hex("cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a3"); // 系统找不到指定的路径。
const GBK_ERR = hex("b4edcef33a20d5d2b2bbb5bdcec4bcfe20612e7478740d0a"); // 错误: 找不到文件 a.txt\r\n
const GBK_YI = hex("d2bb"); // 一 — also valid UTF-8 (U+04BB "һ")

/** Feed buf in pieces of the given sizes (the rest as one piece) */
function feed(d: OutputDecoder, buf: Buffer, sizes: number[]): string {
  let out = "", i = 0;
  for (const n of sizes) { out += d.write(buf.subarray(i, i + n)); i += n; }
  return out + d.write(buf.subarray(i)) + d.end();
}

afterEach(() => _setSystemLegacyEncoding(undefined));

describe("OutputDecoder (Windows, code page 936)", () => {
  it("TextDecoder has gbk/gb18030/big5/shift_jis (full ICU, also Node 20)", () => {
    expect(new TextDecoder("gbk").decode(GBK_HELLO)).toBe("你好，世界");
    for (const l of ["gbk", "gb18030", "big5", "shift_jis", "euc-kr"]) expect(codePageLabel({ gbk: 936, gb18030: 54936, big5: 950, shift_jis: 932, "euc-kr": 949 }[l]!)).toBe(l);
  });

  it("valid UTF-8 stays UTF-8, GBK chunks are decoded as GBK", () => {
    const d = new OutputDecoder("gbk");
    expect(d.write(Buffer.from("构建成功 ✓\n"))).toBe("构建成功 ✓\n");
    expect(d.write(GBK_NOPATH)).toBe("系统找不到指定的路径。");
    expect(d.write(Buffer.from("ok\n"))).toBe("ok\n");
    expect(d.write(Buffer.from("又是 UTF-8"))).toBe("又是 UTF-8");
    expect(d.end()).toBe("");
  });

  it("streaming-safe: GBK and UTF-8 characters split at every byte boundary", () => {
    for (let cut = 1; cut < GBK_ERR.length; cut++) {
      expect(feed(new OutputDecoder("gbk"), GBK_ERR, [cut]), `gbk cut ${cut}`).toBe("错误: 找不到文件 a.txt\r\n");
    }
    const u = Buffer.from("中文输出 → 完成😀");
    for (let cut = 1; cut < u.length; cut++) expect(feed(new OutputDecoder("gbk"), u, [cut]), `utf8 cut ${cut}`).toBe("中文输出 → 完成😀");
    // one byte at a time
    expect(feed(new OutputDecoder("gbk"), GBK_HELLO, Array(GBK_HELLO.length).fill(1))).toBe("你好，世界");
  });

  it("bounded: never holds more than 3 bytes", () => {
    const d = new OutputDecoder("gb18030");
    expect(d.write(hex("9439fc"))).toBe(""); // 3 of the 4 bytes of 😀 in GB18030
    expect(d.write(hex("36"))).toBe("😀");
    const big = Buffer.concat(Array(2000).fill(GBK_HELLO));
    expect(d.write(big).length).toBe(5 * 2000);
    expect((d as unknown as { pending: Uint8Array }).pending.length).toBeLessThanOrEqual(3);
  });

  it("after GBK output, an ambiguous 2-byte chunk (一 = D2 BB) sticks with GBK; a fresh decoder reads it as UTF-8", () => {
    const d = new OutputDecoder("gbk");
    d.write(GBK_HELLO);
    expect(d.write(GBK_YI)).toBe("一");
    expect(new OutputDecoder("gbk").write(GBK_YI)).toBe("һ");
    // 3-byte UTF-8 (CJK) is strong evidence and switches back
    expect(d.write(Buffer.from("好"))).toBe("好");
    expect(d.write(GBK_YI)).toBe("һ");
  });

  it("end() flushes a truncated character instead of dropping it", () => {
    const d = new OutputDecoder("gbk");
    expect(d.write(hex("c4e3ba"))).toBe("你");
    expect(d.end()).toBe("\ufffd");
  });

  it("strings pass through (streams already set to utf8)", () => {
    expect(new OutputDecoder("gbk").write("abc")).toBe("abc");
  });
});

describe("OutputDecoder off Windows / no legacy decoder", () => {
  it("lenient UTF-8 with split characters kept", () => {
    const d = new OutputDecoder(null);
    const u = Buffer.from("你好");
    expect(d.write(u.subarray(0, 4)) + d.write(u.subarray(4)) + d.end()).toBe("你好");
    expect(decodeOutput(GBK_HELLO, null)).toContain("\ufffd");
  });
  it("systemLegacyEncoding is null on macOS and Linux", () => {
    expect(systemLegacyEncoding("darwin")).toBeNull();
    expect(systemLegacyEncoding("linux")).toBeNull();
  });
  it("an unknown label falls back to UTF-8", () => {
    expect(new OutputDecoder("no-such-enc").write(Buffer.from("ok"))).toBe("ok");
  });
});

describe("code page detection", () => {
  it("parses reg query and chcp output", () => {
    expect(parseCodePage("\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    ACP    REG_SZ    936\r\n\r\n")).toBe(936);
    expect(parseCodePage("Active code page: 65001\r\n")).toBe(65001);
    expect(parseCodePage("活动代码页: 936")).toBe(936);
    expect(parseCodePage("garbage")).toBeNull();
  });
  it("maps code pages and locales", () => {
    expect(codePageLabel(936)).toBe("gbk");
    expect(codePageLabel(437)).toBeNull();
    expect(codePageLabel(1252)).toBe("windows-1252");
    expect(labelForLocale("zh-CN")).toBe("gbk");
    expect(labelForLocale("zh-TW")).toBe("big5");
    expect(labelForLocale("zh-Hant-HK")).toBe("big5");
    expect(labelForLocale("ja-JP")).toBe("shift_jis");
    expect(labelForLocale("en-US")).toBeNull();
  });
  it("decodeOutput uses the cached system encoding by default", () => {
    _setSystemLegacyEncoding("gbk");
    expect(decodeOutput(GBK_NOPATH)).toBe("系统找不到指定的路径。");
  });
});
