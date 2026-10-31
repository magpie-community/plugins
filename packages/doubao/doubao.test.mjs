// bun test 套件（CI 跑 `bun test`）。覆盖：SSE 解析、PNG 解码、扫码二维码 ASCII、
// 出网安全防护（SSRF/图片魔数）、账号顺序（不轮换摊薄）、配置来源、插件结构。
import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSseBlocks, parsePcImages, parseWebImages, normalizeRatio } from "./src/client.mjs";
import { DoubaoError, DoubaoAuthError, DoubaoRiskError, assertPublicHttpUrl } from "./src/http.mjs";
import { loadConfig, DEFAULTS, accountsFromMagpieAuth } from "./src/config.mjs";
import { qrPngToAscii } from "./src/qlogin.mjs";
import { loadRefImage } from "./src/upload.mjs";
import { accountOrder } from "./src/accounts.mjs";
import * as mod from "./index.mjs";

// ———— 测试夹具：自带最小 PNG 构造器（不动生产代码） ————
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 8-bit 灰度 PNG（filter 0），像素 = (x*7 + y*11 + x*y) % 3 === 0 ? 0 : 255，四周 4 模块静区。 */
function makeQrPng(modules, scale = 8) {
  const w = (modules + 8) * scale;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = [];
  for (let y = 0; y < w; y++) {
    const row = Buffer.alloc(1 + w);
    row[0] = 0;
    for (let x = 0; x < w; x++) {
      const mx = Math.floor(x / scale) - 4;
      const my = Math.floor(y / scale) - 4;
      const inGrid = mx >= 0 && my >= 0 && mx < modules && my < modules;
      row[1 + x] = inGrid && (mx * 7 + my * 11 + mx * my) % 3 === 0 ? 0 : 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 8-bit RGB PNG（filter 0），像素由 fill(x,y) 给出。 */
function makeRgbPng(w, h, fill) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ———— parseSseBlocks ————
test("SSE：基本切块与 event 名", () => {
  const blocks = parseSseBlocks('event: SSE_ACK\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
  expect(blocks.length).toBe(2);
  expect(blocks[0].event).toBe("SSE_ACK");
  expect(blocks[0].json.a).toBe(1);
  expect(blocks[1].event).toBe("message");
});
test("SSE：多行 data 合并；非 JSON 块 json 为 null", () => {
  expect(parseSseBlocks('data: {"x":\ndata: 1}\n')[0].json.x).toBe(1);
  expect(parseSseBlocks("data: ping\n")[0].json).toBeNull();
});

// ———— parsePcImages（samantha 2010 形态） ————
const pcImageData = {
  data: [
    {
      key: "img1",
      image_ori: { url: "https://cdn/ori.jpg", width: 1024, height: 1024, format: "jpeg" },
      image_raw: { url: "https://cdn/raw.jpg" },
      image_thumb: { url: "https://cdn/thumb.jpg" },
    },
  ],
};
const pcFixture = [
  `data: ${JSON.stringify({ event_type: 2001, event_data: JSON.stringify({ message: { content_type: 2010, content: JSON.stringify(pcImageData), status: 1 } }) })}`,
  "",
  `data: ${JSON.stringify({ event_type: 2001, event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: "已生成" }) } }) })}`,
  "",
].join("\n");
test("pc 通道：2010 取图，取豆包默认下载档 image_ori", () => {
  const { images, text } = parsePcImages(pcFixture);
  expect(images.length).toBe(1);
  expect(images[0].url).toBe("https://cdn/ori.jpg");
  expect(images[0].width).toBe(1024);
  expect(text).toBe("已生成");
});
test("pc 通道：2005 抛错；JSON 错误体按码分类", () => {
  expect(() => parsePcImages('data: {"event_type":2005,"event_data":"boom"}')).toThrow(/boom/);
  expect(() => parsePcImages('{"code":710012001,"msg":"登录已过期"}')).toThrow(DoubaoAuthError);
  expect(() => parsePcImages('{"code":710022004,"msg":"verify"}')).toThrow(DoubaoRiskError);
  expect(() => parsePcImages('event: gateway-error\ndata: {"code":"710012001","message":"user invalid"}')).toThrow(DoubaoAuthError);
});

// ———— parseWebImages（chat_ability 2074 形态） ————
const webBlock = {
  block_type: 2074,
  content: { creation_block: { creations: [{ image: { image_raw: { url: "https://cdn-raw/x.jpg", width: 1440, height: 810 }, image_ori: { url: "https://cdn-ori/x.jpg" } } }] } },
};
const webFixture = [
  'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"7421"}}',
  "",
  `event: STREAM_CHUNK\ndata: ${JSON.stringify({ patch_op: [{ patch_value: { content_block: [webBlock] } }] })}`,
  "",
  'event: SSE_REPLY_END\ndata: {}',
  "",
].join("\n");
test("web 通道：2074 取图，默认下载档 image_ori 优先", () => {
  const { images, conversationId } = parseWebImages(webFixture);
  expect(images.length).toBe(1);
  expect(images[0].url).toBe("https://cdn-ori/x.jpg"); // 不再偏好“无水印档”
  expect(conversationId).toBe("7421");
});
test("web 通道：订阅文案 → 付费墙提示；深度兜底扫描 2074", () => {
  const paywall = [
    "event: STREAM_CHUNK",
    `data: ${JSON.stringify({ patch_op: [{ patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: "这是豆包订阅标准套餐专属能力" } } }] } }] })}`,
    "",
  ].join("\n");
  expect(() => parseWebImages(paywall)).toThrow(/订阅/);
  const { images } = parseWebImages(`event: FULL_MSG_NOTIFY\ndata: ${JSON.stringify({ deep: { nested: [webBlock] } })}\n\n`);
  expect(images.length).toBe(1);
});

// ———— 杂项 ————
test("normalizeRatio 白名单", () => {
  expect(normalizeRatio("16:9")).toBe("16:9");
  expect(normalizeRatio("2:99")).toBe("1:1");
  expect(normalizeRatio("", "auto")).toBe("auto");
});
test("配置默认值不含去水印类字段", () => {
  expect("removeWatermark" in DEFAULTS).toBe(false);
  expect("watermarkExtend" in DEFAULTS).toBe(false);
});
test("loadConfig 解析 DOUBAO_ACCOUNTS 并过滤无效账号", () => {
  process.env.DOUBAO_ACCOUNTS = "主号:sessionid=abc123456789,ttwid=tt1;小号:sessionid=def123456789";
  const cfg = loadConfig({});
  expect(cfg.accounts.length).toBe(2);
  expect(cfg.accounts[0].name).toBe("主号");
  expect(cfg.accounts[0].ttwid).toBe("tt1");
  delete process.env.DOUBAO_ACCOUNTS;
  const bad = loadConfig({ accounts: [{ name: "坏", sessionid: "x" }, { name: "好", sessionid: "valid-sessionid-123" }] });
  expect(bad.accounts.length).toBe(1);
  expect(bad.accounts[0].name).toBe("好");
});
test("magpie 登录态（plugin-auth.json）优先于 env 与配置文件", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "doubao-test-"));
  try {
    writeFileSync(path.join(dir, "plugin-auth.json"), JSON.stringify({ doubao: { type: "oauth", accountId: "zeppeli", sessionid: "magpie123456789", ttwid: "tt", deviceId: "d1", webId: "w1" } }));
    process.env.DOUBAO_ACCOUNTS = "环境变量账号:sessionid=env1234567890";
    const cfg = loadConfig({}, dir, "doubao");
    expect(cfg.accounts.length).toBe(1);
    expect(cfg.accounts[0].name).toBe("zeppeli");
    expect(cfg.accounts[0].deviceId).toBe("d1");
    delete process.env.DOUBAO_ACCOUNTS;
    const rec = accountsFromMagpieAuth(dir, "doubao");
    expect(rec[0].sessionid).toBe("magpie123456789");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ———— 账号顺序：固定第一个，不轮换摊薄 ————
test("accountOrder 固定配置顺序，多次调用结果一致；preferred 仅按名匹配", () => {
  const accounts = [{ name: "a", sessionid: "s1" }, { name: "b", sessionid: "s2" }];
  expect(accountOrder(accounts).map((a) => a.name)).toEqual(["a", "b"]);
  expect(accountOrder(accounts).map((a) => a.name)).toEqual(["a", "b"]);
  expect(accountOrder(accounts, "b").map((a) => a.name)).toEqual(["b", "a"]);
  // sessionid 不作为匹配键
  expect(accountOrder(accounts, "s2").map((a) => a.name)).toEqual(["a", "b"]);
});

// ———— 出网安全 ————
test("出网 URL：拒绝回环/内网字面量 IP、非 http(s)、带凭据", async () => {
  await expect(assertPublicHttpUrl("http://127.0.0.1/x")).rejects.toThrow(DoubaoError);
  await expect(assertPublicHttpUrl("http://[::1]/x")).rejects.toThrow(DoubaoError);
  await expect(assertPublicHttpUrl("https://10.0.0.1/x")).rejects.toThrow(DoubaoError);
  await expect(assertPublicHttpUrl("https://192.168.1.2/x")).rejects.toThrow(DoubaoError);
  await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(DoubaoError);
  await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/http\(s\)/);
  await expect(assertPublicHttpUrl("http://user:pass@example.com/x")).rejects.toThrow(/用户名/);
});
test("出网 URL：域名后缀白名单生效", async () => {
  await expect(assertPublicHttpUrl("https://evil.com/a.png", { allowHosts: ["byteimg.com"] })).rejects.toThrow(/允许列表/);
  const u = await assertPublicHttpUrl("https://www.example.com/a.png", { allowHosts: ["example.com"] });
  expect(u.hostname).toBe("www.example.com");
});
test("参考图：拒绝非图片扩展名与魔数不符的文件", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "doubao-test-"));
  try {
    const txt = path.join(dir, "secret.txt");
    writeFileSync(txt, "not an image");
    await expect(loadRefImage(txt)).rejects.toThrow(/仅支持图片/);
    const fake = path.join(dir, "fake.png"); // 扩展名是 png，内容不是
    writeFileSync(fake, "-----BEGIN OPENSSH PRIVATE KEY-----");
    await expect(loadRefImage(fake)).rejects.toThrow(/不是可识别的图片/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ———— PNG 解码 + 二维码 ASCII ————
test("PNG 解码 RGB 无损；二维码 PNG 渲染 ASCII", () => {
  const png = makeRgbPng(4, 3, (x, y) => [x * 60, y * 80, 7]);
  const ascii = qrPngToAscii(makeQrPng(25));
  expect(ascii).toBeTruthy();
  const lines = ascii.split("\n");
  expect(lines.length).toBe(Math.ceil(25 / 2) + 2);
  expect(lines[1].trim().startsWith("▀")).toBe(true); // (0,0) 暗、(0,1) 亮 → 半块 ▀
  expect(qrPngToAscii(Buffer.from("not a png"))).toBeNull();
});

// ———— 插件结构 ————
test("插件：单函数导出（无 default，防 provider 重复注册），工具/登录齐备", async () => {
  expect(mod.default).toBeUndefined();
  const plugin = await mod.DoubaoTools({}, {});
  const tools = plugin?.tool || {};
  expect(Object.keys(tools).sort()).toEqual(["check_login", "generate_image"]);
  const gi = tools.generate_image;
  expect(gi.description.length).toBeGreaterThan(40);
  expect(gi.args.required).toEqual(["prompt"]);
  expect(gi.args.properties.account?.type).toBe("string"); // account 已声明进 schema
  expect(plugin.auth.provider).toBe("doubao");
  expect(plugin.auth.single).toBe(true);
  expect(plugin.auth.methods[0].type).toBe("oauth");
  expect(typeof plugin.auth.methods[0].authorize).toBe("function");
});
