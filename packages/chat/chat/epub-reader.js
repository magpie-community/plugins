(() => {
  "use strict";
  const MiB = 1024 * 1024, fileLimit = 8 * MiB, extractLimit = 24 * MiB, textLimit = 2 * MiB;
  const damaged = "EPUB 文件损坏或目录不完整。";
  const tooLarge = "EPUB 正文太大，请分卷后添加。";
  const encrypted = "EPUB 正文已加密，无法读取。";
  const fail = message => { throw new Error(message); };
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  function isEpub(file) {
    return !!file && (/\.epub$/i.test(file.name || "") ||
      [file.type, file.mime].some(type => /^application\/epub\+zip(?:\s*;|$)/i.test(type || "")));
  }

  function fileBytes(url) {
    if (typeof url !== "string") fail(damaged);
    const comma = url.indexOf(",");
    if (comma < 0 || !/^data:[^,]*;base64$/i.test(url.slice(0, comma))) fail(damaged);
    if (url.length - comma - 1 > 4 * Math.ceil(fileLimit / 3)) fail("EPUB 文件超过 8 MiB，请分卷后添加。");
    let binary;
    try { binary = atob(url.slice(comma + 1)); } catch { fail(damaged); }
    if (binary.length > fileLimit) fail("EPUB 文件超过 8 MiB，请分卷后添加。");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  });
  function checksum(bytes) {
    let crc = -1;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ -1) >>> 0;
  }

  async function inflate(packed, size) {
    let inflater;
    try { inflater = new DecompressionStream("deflate-raw"); }
    catch { fail("当前浏览器无法解压 EPUB，请更新后再试。"); }
    let pos = 0;
    const input = new ReadableStream({ pull(controller) {
      if (pos === packed.length) return controller.close();
      const next = Math.min(pos + 4096, packed.length);
      controller.enqueue(packed.subarray(pos, next));
      pos = next;
    } });
    const reader = input.pipeThrough(inflater).getReader();
    const bytes = new Uint8Array(size);
    let written = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length > size - written) {
          await reader.cancel();
          fail(damaged);
        }
        bytes.set(value, written);
        written += value.length;
      }
    } catch { fail(damaged); }
    if (written !== size) fail(damaged);
    return bytes;
  }

  function openZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = p => view.getUint16(p, true), u32 = p => view.getUint32(p, true);
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--) {
      if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    }
    if (end < Math.max(0, bytes.length - 65557)) fail(damaged);
    const count = u16(end + 10), start = u32(end + 16);
    if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count ||
        count > 10000 || start + u32(end + 12) !== end) fail(damaged);
    const names = new Map();
    let pos = start, extracted = 0;
    function nameAt(offset, length) {
      try { return utf8.decode(bytes.subarray(offset, offset + length)); } catch { fail(damaged); }
    }
    for (let i = 0; i < count; i++) {
      if (pos + 46 > end || u32(pos) !== 0x02014b50 || u16(pos + 34)) fail(damaged);
      const length = u16(pos + 28);
      const next = pos + 46 + length + u16(pos + 30) + u16(pos + 32);
      if (next > end) fail(damaged);
      const name = nameAt(pos + 46, length);
      if (!name || names.has(name)) fail(damaged);
      names.set(name, pos);
      pos = next;
    }
    if (pos !== end) fail(damaged);
    return {
      has: name => names.has(name),
      async read(name, maxSize) {
        const c = names.get(name);
        if (c === undefined) fail(damaged);
        const flags = u16(c + 8), method = u16(c + 10), packed = u32(c + 20), size = u32(c + 24);
        if (flags & 0x41) fail(encrypted);
        if (size > maxSize || size > extractLimit - extracted) fail(tooLarge);
        extracted += size;
        const local = u32(c + 42);
        if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 6) !== flags ||
            u16(local + 8) !== method) fail(damaged);
        const length = u16(local + 26), data = local + 30 + length + u16(local + 28);
        if (data + packed > start || nameAt(local + 30, length) !== name) fail(damaged);
        let raw = bytes.subarray(data, data + packed);
        if (method === 8) raw = await inflate(raw, size);
        else if (method !== 0) fail("这种 EPUB 压缩格式暂不支持。");
        if (raw.length !== size || checksum(raw) !== u32(c + 16)) fail(damaged);
        let encoding = "utf-8";
        if ((raw[0] === 255 && raw[1] === 254) || (raw[0] === 60 && raw[1] === 0)) encoding = "utf-16le";
        if ((raw[0] === 254 && raw[1] === 255) || (raw[0] === 0 && raw[1] === 60)) encoding = "utf-16be";
        try { return new TextDecoder(encoding, { fatal: true }).decode(raw); } catch { fail(damaged); }
      }
    };
  }

  // References are paths within the ZIP. Decode each segment after separating URL fragments.
  function pathFor(baseFile, href) {
    if (!href || /^(?:[a-z][\w+.-]*:|\/)/i.test(href)) fail(damaged);
    const parts = baseFile.split("/");
    parts.pop();
    for (const segment of href.split(/[?#]/, 1)[0].split("/")) {
      let name;
      try { name = decodeURIComponent(segment); } catch { fail(damaged); }
      if (/[\/\\\0]/.test(name)) fail(damaged);
      if (name === "..") {
        if (!parts.length) fail(damaged);
        parts.pop();
      } else if (name && name !== ".") parts.push(name);
    }
    return parts.join("/");
  }

  // Older XHTML books use named HTML entities from a DTD. Decode them locally, as numeric
  // XML references; CDATA, comments and processing instructions must retain their literal text.
  function expandHtmlEntities(source) {
    const template = document.createElement("template"), cache = new Map();
    return source.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|&([a-z][a-z0-9]{0,31});/gi, (token, name) => {
      if (!name) return token;
      if (!cache.has(token)) {
        template.innerHTML = '<i data-value="' + token + '"></i>';
        const value = template.content.firstChild.getAttribute("data-value");
        if (value === token) fail(damaged);
        cache.set(token, Array.from(value, c => "&#" + c.codePointAt(0) + ";").join(""));
      }
      return cache.get(token);
    });
  }

  function xml(source, chapter = false) {
    // External declarations are unnecessary for reading text; never resolve entities from the book.
    if (/<!ENTITY\s/i.test(source)) fail("EPUB 使用了不支持的 XML 实体声明。");
    const start = source.search(/<!DOCTYPE\s/i);
    if (start !== -1) {
      const decl = /^<!DOCTYPE\s+(?:[^<>"'\[]|"[^"]*"|'[^']*')*>/i.exec(source.slice(start));
      if (!decl) fail(damaged);
      source = source.slice(0, start) + source.slice(start + decl[0].length);
      if (/<!DOCTYPE\s/i.test(source)) fail(damaged);
    }
    const parser = new DOMParser();
    let doc = parser.parseFromString(source, "application/xml");
    if (doc.getElementsByTagNameNS("*", "parsererror").length && chapter && source.includes("&")) {
      doc = parser.parseFromString(expandHtmlEntities(source), "application/xml");
    }
    if (doc.getElementsByTagNameNS("*", "parsererror").length) fail(damaged);
    return doc;
  }

  const elements = (root, name) => Array.from(root.getElementsByTagNameNS("*", name));
  const blocks = new Set("address article aside blockquote br caption dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul".split(" "));
  const ignored = new Set("head title script style noscript template iframe object".split(" "));

  function chapterText(source, type) {
    let body;
    if (type === "text/html") {
      // The template's owner document has no browsing context, so image and frame URLs stay inert.
      const html = document.createElement("template").content.ownerDocument.createElement("html");
      html.innerHTML = source;
      body = html.querySelector("body");
    } else {
      body = elements(xml(source, true), "body")[0];
    }
    if (!body) fail(damaged);
    const lines = [];
    let pieces = [];
    function flush() {
      if (!pieces.length) return;
      const line = pieces.join("").replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, "");
      if (line) lines.push(line);
      pieces = [];
    }
    for (let node = body.firstChild; node;) {
      const tag = node.nodeType === 1 ? node.localName.toLowerCase() : "";
      if (node.nodeType === 3 || node.nodeType === 4) pieces.push(node.nodeValue);
      if (blocks.has(tag)) flush();
      if (!ignored.has(tag) && node.firstChild) {
        node = node.firstChild;
        continue;
      }
      while (node !== body) {
        if (node.nodeType === 1 && blocks.has(node.localName.toLowerCase())) flush();
        if (node.nextSibling) break;
        node = node.parentNode;
      }
      node = node === body ? null : node.nextSibling;
    }
    flush();
    const text = lines.join("\n\n");
    const imageOnly = !text && !!body.querySelector("img, picture, svg, image, canvas, object[type^='image/']");
    return { text, imageOnly };
  }

  async function read(dataUrl) {
    const archive = openZip(fileBytes(dataUrl));
    const locked = new Set();
    const encryption = "META-INF/encryption.xml";
    if (archive.has(encryption)) {
      const doc = xml(await archive.read(encryption, MiB));
      for (const el of elements(doc, "CipherReference")) locked.add(pathFor("", el.getAttribute("URI")));
    }
    function readFile(name, maxSize) {
      if (locked.has(name)) fail(encrypted);
      return archive.read(name, maxSize);
    }
    const container = xml(await readFile("META-INF/container.xml", MiB));
    const roots = elements(container, "rootfile");
    const root = roots.find(el => el.getAttribute("media-type") === "application/oebps-package+xml") || roots[0];
    const opfPath = pathFor("", root?.getAttribute("full-path"));
    const opf = xml(await readFile(opfPath, MiB));
    const manifest = elements(opf, "manifest")[0], spine = elements(opf, "spine")[0];
    if (!manifest || !spine) fail(damaged);
    const items = new Map();
    for (const item of elements(manifest, "item")) {
      const id = item.getAttribute("id");
      if (!id || items.has(id)) fail(damaged);
      items.set(id, item);
    }
    const chapters = [], seenPaths = new Set();
    let length = 0, imagePages = 0;
    for (const ref of elements(spine, "itemref")) {
      const item = items.get(ref.getAttribute("idref"));
      if (!item) fail(damaged);
      const name = pathFor(opfPath, item.getAttribute("href"));
      if (seenPaths.has(name)) continue;
      seenPaths.add(name);
      const type = item.getAttribute("media-type");
      if (type !== "application/xhtml+xml" && type !== "text/html") fail("EPUB 含有暂不支持的章节格式。");
      const { text, imageOnly } = chapterText(await readFile(name, 8 * MiB), type);
      if (imageOnly) imagePages++;
      if (!text) continue;
      length += text.length + (chapters.length ? 2 : 0);
      if (length > textLimit) fail(tooLarge);
      chapters.push(text);
    }
    if (!chapters.length) fail("EPUB 中没有可读取的文字，可能是扫描版。");
    const text = chapters.join("\n\n");
    let characters = 0;
    for (const char of text) if (!/\p{White_Space}/u.test(char)) characters++;
    return { text, characters, imagePages };
  }

  globalThis.MagpieEpub = { isEpub, read };
})();
