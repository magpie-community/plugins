import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { decodePickFolderStdout } from "../../daemon/src/util/pickFolderWin.js";

describe("pickFolder stdout decoding", () => {
  it("Base64 UTF-8 path", () => {
    const path = "D:\\workwork\\magpie插件";
    const b64 = Buffer.from(path, "utf8").toString("base64");
    expect(decodePickFolderStdout(`${b64}\r\n`)).toBe(path);
  });

  it("plain ASCII path (old Write-Output)", () => {
    expect(decodePickFolderStdout("D:\\workwork\\demo\r\n")).toBe("D:\\workwork\\demo");
  });

  it("CP936 bytes (static sample) fall back to GBK", () => {
    // GBK encoding of "D:\\workwork\\magpie插件": 插=b2e5 件=bcfe
    const buf = Buffer.concat([Buffer.from("D:\\workwork\\magpie", "ascii"), Buffer.from("b2e5bcfe", "hex"), Buffer.from("\r\n")]);
    expect(decodePickFolderStdout(buf)).toBe("D:\\workwork\\magpie插件");
  });

  it.skipIf(process.platform !== "win32")("CP936 console output falls back to GBK (real powershell.exe)", () => {
    const buf = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); " +
          "[Console]::Out.WriteLine('D:\\workwork\\magpie插件')",
      ],
      { encoding: "buffer" },
    );
    expect(decodePickFolderStdout(buf)).toBe("D:\\workwork\\magpie插件");
  });
});
