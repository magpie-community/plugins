import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import "./chat/epub-reader.js";

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, contents, method = 8, declaredSize] of files) {
    const name = Buffer.from(path), body = Buffer.from(contents);
    const data = method === 8 ? deflateRawSync(body) : body;
    const l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); c.writeUInt32LE(0x02014b50);
    for (const [header, shift] of [[l, 0], [c, 2]]) {
      header.writeUInt16LE(20, 4 + shift);
      header.writeUInt16LE(method, 8 + shift);
      header.writeUInt32LE(crc32(body), 14 + shift);
      header.writeUInt32LE(data.length, 18 + shift);
      header.writeUInt32LE(declaredSize ?? body.length, 22 + shift);
      header.writeUInt16LE(name.length, 26 + shift);
    }
    c.writeUInt32LE(offset, 42);
    local.push(l, name, data); central.push(c, name);
    offset += l.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return "data:application/epub+zip;base64," + Buffer.concat([...local, index, end]).toString("base64");
}

function book(chapters, extras = []) {
  const manifest = chapters.map(([href, , type = "application/xhtml+xml"], i) =>
    `<item id="c${i}" href="${href}" media-type="${type}"/>`).join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  return zip([
    ["mimetype", "application/epub+zip", 0],
    ["META-INF/container.xml", '<container><rootfiles><rootfile full-path="OPS/package/book.opf"/></rootfiles></container>'],
    ["OPS/package/book.opf", `<package><manifest>${manifest}</manifest><spine>${spine}</spine></package>`],
    ...[...chapters].reverse().filter(([, source]) => source != null).map(([href, source, , method]) =>
      [decodeURIComponent(new URL(href, "https://archive/OPS/package/book.opf").pathname).slice(1), source, method]),
    ...extras
  ]);
}

test("EPUB recognition, malformed ZIPs and false uncompressed sizes", async () => {
  const { isEpub, read } = globalThis.MagpieEpub;
  expect(isEpub({ name: "文章.EPUB", type: "application/octet-stream" })).toBe(true);
  expect(isEpub({ type: "application/epub+zip" })).toBe(true);
  expect(isEpub({ name: "文章.pdf" })).toBe(false);
  await expect(read("data:;base64,UEs=")).rejects.toThrow("损坏");
  await expect(read("data:;base64," + "A".repeat(4 * Math.ceil((8 * 1024 * 1024) / 3) + 4))).rejects.toThrow("8 MiB");
  const stored = zip([["META-INF/container.xml", "original", 0]]);
  const bytes = Buffer.from(stored.split(",")[1], "base64");
  bytes[bytes.indexOf("original")] ^= 1;
  await expect(read("data:;base64," + bytes.toString("base64"))).rejects.toThrow("损坏");
  await expect(read(zip([["META-INF/container.xml", "x".repeat(50000), 8, 1]]))).rejects.toThrow("损坏");
  await expect(read(zip([["META-INF/container.xml", "x", 8, 25 * 1024 * 1024]]))).rejects.toThrow("太大");
});

// CI uses its installed browser; EPUB_TEST_BROWSER can select another Chromium executable.
const browserPath = process.env.EPUB_TEST_BROWSER || ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  .map(name => Bun.which(name)).find(Boolean);
test.skipIf(!browserPath && !process.env.CI)("reads complete books in spine order without loading external resources", async () => {
  if (!browserPath) throw new Error("Browser tests need Chrome or Chromium in PATH, or EPUB_TEST_BROWSER.");
  const xhtml = text => `<html xmlns="http://www.w3.org/1999/xhtml"><body>${text}</body></html>`;
  const first = "../text/第%20一.xhtml#start", second = "../text/2.html";
  const fixtures = {
    mixed: book([
      [first, xhtml('<p>红<b>楼</b>梦𠀀。</p><img src="/unexpected"/><script>window.injected = true</script><style>隐藏</style>'), undefined, 0],
      [second, '<html><head><title>书名不该进入正文</title></head><body><p>次<b>章</b>。<p>有 空格<br>下一行<img src="/unexpected"><iframe src="/unexpected"></iframe></body></html>', "text/html"]
    ], [["META-INF/encryption.xml", '<encryption><CipherReference URI="OPS/font.otf"/></encryption>']]),
    duplicates: book([[first, xhtml("<p>同文</p>")], ["../text/./第%20一.xhtml#end", null],
      ["../text/second.xhtml", xhtml("<p>同文</p>")]]),
    hybrid: book([
      ["../cover.xhtml", xhtml('<svg xmlns="http://www.w3.org/2000/svg"><image href="cover.jpg"/></svg>')],
      [first, xhtml("<p>可读正文</p>")],
      ["../text/scanned.html", '<img src="/unexpected">', "text/html"],
      ["../text/scanned.html#bottom", null, "text/html"],
      ["../text/blank.xhtml", xhtml("<p> </p>")]
    ]),
    legacy: book([[first, '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "/unexpected"><html><body><p>古&nbsp;籍&mdash;𠀀&#133;完</p><p><![CDATA[&nbsp;]]></p></body></html>']]),
    long: book([[first, xhtml("<p>" + "文".repeat(100000) + "末</p>")]]),
    missing: book([[first, xhtml("<p>第一页</p>")], [second, null]]),
    locked: book([[first, xhtml("<p>加密章节</p>")]], [["META-INF/encryption.xml",
      '<encryption><CipherReference URI="OPS/text/第%20一.xhtml"/></encryption>']]),
    invalid: book([[first, "<html><body><p>坏了</body></html>"]]),
    unterminated: book([[first, "<html><body>" + "<!--".repeat(50000) + "&nbsp;"]]),
    empty: book([[first, xhtml('<img src="/unexpected"/>')]]),
    oversized: book([[first, xhtml("<p>" + "x".repeat(2 * 1024 * 1024 + 1) + "</p>")]])
  };
  const { promise, resolve } = Promise.withResolvers();
  const requested = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/reader.js") return new Response(Bun.file(join(import.meta.dir, "chat/epub-reader.js")));
    if (path === "/result") { resolve(await req.json()); return new Response("ok"); }
    if (path === "/") return new Response(`<!DOCTYPE html><meta charset="utf-8"><script src="/reader.js"></script><script>
      (async () => {
        const result = {};
        for (const [name, url] of Object.entries(${JSON.stringify(fixtures)})) {
          try {
            const { text, characters, imagePages } = await MagpieEpub.read(url);
            result[name] = { text: text.length > 1000 ? text.slice(-1) : text, characters, imagePages };
          } catch (e) { result[name] = e.message; }
        }
        result.injected = !!window.injected;
        await fetch('/result', {method:'POST', body:JSON.stringify(result)});
      })();
      </script>`, { headers: { "Content-Type": "text/html" } });
    requested.push(path);
    return new Response("", { status: 404 });
  } });
  // A browser that is slow to start (a cold CI runner took 16s where a run takes 1.3s) is not a reader
  // failure: each try gets its own profile and 10s (7x a normal run), and a try that posts nothing is
  // killed and replaced. A browser that exits by itself still fails at once.
  const tries = 3, tryMs = 10000;
  let result;
  try {
    for (let attempt = 1; !result; attempt++) {
      const profile = mkdtempSync(join(tmpdir(), "magpie-epub-browser-"));
      const proc = Bun.spawn([browserPath, "--headless", "--disable-gpu", "--disable-background-networking",
        "--no-first-run", "--use-mock-keychain", "--user-data-dir=" + profile, String(server.url)], { stdout: "ignore", stderr: "ignore" });
      let timer;
      try {
        result = await Promise.race([promise, proc.exited.then(() => { throw new Error("browser exited"); }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), tryMs); })]);
        if (!result && attempt >= tries) throw new Error(`browser timed out ${tries} times`);
      } finally {
        clearTimeout(timer); proc.kill(); await proc.exited;
        rmSync(profile, { recursive: true, force: true });
      }
    }
    expect(result.mixed).toEqual({ text: "红楼梦𠀀。\n\n次章。\n\n有 空格\n\n下一行", characters: 14, imagePages: 0 });
    expect(result.duplicates).toEqual({ text: "同文\n\n同文", characters: 4, imagePages: 0 });
    expect(result.hybrid).toEqual({ text: "可读正文", characters: 4, imagePages: 2 });
    expect(result.legacy).toEqual({ text: "古 籍—𠀀 完\n\n&nbsp;", characters: 11, imagePages: 0 });
    expect(result.long).toEqual({ text: "末", characters: 100001, imagePages: 0 });
    expect(result.missing).toContain("损坏");
    expect(result.locked).toContain("已加密");
    expect(result.invalid).toContain("损坏");
    expect(result.unterminated).toContain("损坏");
    expect(result.empty).toContain("没有可读取的文字");
    expect(result.oversized).toContain("太大");
    expect(result.injected).toBe(false);
    expect(requested).not.toContain("/unexpected");
  } finally {
    await server.stop(true);
  }
}, 60000);
