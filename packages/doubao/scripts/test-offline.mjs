// 离线单测：不联网，用合成 SSE 报文验证解析器、配置解析与插件结构。
//   node scripts/test-offline.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { parseSseBlocks, parsePcImages, parseWebImages, normalizeRatio } from "../src/client.mjs";
import { DoubaoError, DoubaoAuthError, DoubaoRiskError } from "../src/http.mjs";
import { loadConfig, DEFAULTS } from "../src/config.mjs";
import { qrPngToAscii } from "../src/qlogin.mjs";
import { encodePng, decodePng, cropPngBottom } from "../src/png.mjs";
import { parseExtendFrac } from "../src/watermark.mjs";
import { DoubaoTools } from "../index.mjs";

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

// ————— parseSseBlocks —————
console.log("parseSseBlocks");
ok("基本切块与 event 名", () => {
  const blocks = parseSseBlocks('event: SSE_ACK\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].event, "SSE_ACK");
  assert.equal(blocks[0].json.a, 1);
  assert.equal(blocks[1].event, "message");
  assert.equal(blocks[1].json.b, 2);
});
ok("多行 data: 合并", () => {
  const blocks = parseSseBlocks('data: {"x":\ndata: 1}\n');
  assert.equal(blocks[0].json.x, 1);
});
ok("非 JSON 数据块 json 为 null", () => {
  const blocks = parseSseBlocks("data: ping\n");
  assert.equal(blocks[0].json, null);
});

// ————— parsePcImages（samantha 2010 形态，doubao2api 真值） —————
console.log("parsePcImages");
// 真实响应是三层 JSON 嵌套（SSE data → event_data 字符串 → message.content 字符串），程序化构造
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
const pcBlockImage = `data: ${JSON.stringify({
  event_type: 2001,
  event_data: JSON.stringify({ message: { content_type: 2010, content: JSON.stringify(pcImageData), status: 1 } }),
})}`;
const pcBlockText = `data: ${JSON.stringify({
  event_type: 2001,
  event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: "已生成" }) } }),
})}`;
const pcFixture = [pcBlockImage, "", pcBlockText, ""].join("\n");
ok("提取 image_ori 为最优档（pc 顺序）", () => {
  const { images, text } = parsePcImages(pcFixture);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "https://cdn/ori.jpg");
  assert.equal(images[0].width, 1024);
  assert.equal(text, "已生成");
});
ok("event_type 2005 抛错", () => {
  assert.throws(() => parsePcImages('data: {"event_type":2005,"event_data":"boom"}'), /boom/);
});
ok("JSON 错误体分类：登录失效", () => {
  assert.throws(() => parsePcImages('{"code":710012001,"msg":"登录已过期"}'), DoubaoAuthError);
});
ok("JSON 错误体分类：风控", () => {
  try {
    parsePcImages('{"code":710022004,"msg":"verify"}');
    assert.fail("应当抛出");
  } catch (err) {
    assert.ok(err instanceof DoubaoRiskError);
    assert.match(err.hint, /风控|冷却/);
  }
});
ok("gateway-error 抛登录失效", () => {
  assert.throws(
    () => parsePcImages('event: gateway-error\ndata: {"code":"710012001","message":"user invalid"}'),
    DoubaoAuthError,
  );
});

// ————— parseWebImages（chat_ability 2074 形态，web-mcp 笔记） —————
console.log("parseWebImages");
const webBlock = {
  block_type: 2074,
  content: {
    creation_block: {
      creations: [
        {
          image: {
            image_raw: { url: "https://cdn-raw/x.jpg", width: 1440, height: 810 },
            lwm3_url: "https://cdn-lwm/x.jpg",
          },
        },
      ],
    },
  },
};
const webFixture = [
  'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"7421"}}',
  "",
  `event: STREAM_CHUNK\ndata: ${JSON.stringify({ patch_op: [{ patch_value: { content_block: [webBlock] } }] })}`,
  "",
  'event: STREAM_CHUNK\ndata: {"text":"生成中"}',
  "",
  'event: SSE_REPLY_END\ndata: {}',
  "",
].join("\n");
ok("2074 creation 提取，image_raw 优先（web 顺序）", () => {
  const { images, text, conversationId } = parseWebImages(webFixture);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "https://cdn-raw/x.jpg");
  assert.equal(images[0].width, 1440);
  assert.equal(conversationId, "7421");
  assert.ok(text.includes("生成中"));
});
ok("无图但带订阅文案 → 付费墙提示", () => {
  const fixture = [
    'event: STREAM_CHUNK',
    `data: ${JSON.stringify({ patch_op: [{ patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: "这是豆包订阅标准套餐专属能力" } } }] } }] })}`,
    "",
  ].join("\n");
  const err = (() => {
    try {
      parseWebImages(fixture);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof DoubaoError);
  assert.match(err.message, /订阅/);
});
ok("深度兜底扫描命中嵌套 2074", () => {
  const fixture = `event: FULL_MSG_NOTIFY\ndata: ${JSON.stringify({ deep: { nested: [webBlock] } })}\n\n`;
  const { images } = parseWebImages(fixture);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, "https://cdn-raw/x.jpg");
});

// ————— 二维码 PNG 解码 —————
console.log("qrPngToAscii");
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
/** 自造伪二维码 PNG（8-bit 灰度、filter 0，四周 4 模块静区）。 */
function makeQrPng(modules, scale = 8) {
  const w = (modules + 8) * scale;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const rows = [];
  for (let y = 0; y < w; y++) {
    const row = Buffer.alloc(1 + w);
    row[0] = 0; // filter: none
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
ok("解码自造 PNG 为 ASCII 半块画", () => {
  const ascii = qrPngToAscii(makeQrPng(25));
  assert.ok(ascii, "应当解码成功");
  const lines = ascii.split("\n");
  assert.equal(lines.length, Math.ceil(25 / 2) + 2, "13 对行 + 上下白边");
  // (0,0) 依图案公式为暗、(0,1) 为亮 → 首个内容行第 1 个内容字符应为 "▀"
  const content = lines[1].trim();
  assert.ok(content.startsWith("▀"), `首字符应为 ▀，实际: ${content.slice(0, 3)}`);
});
ok("非 PNG 输入返回 null", () => {
  assert.equal(qrPngToAscii(Buffer.from("not a png")), null);
});

// ————— PNG 编解码与去水印裁剪 —————
console.log("png & watermark crop");
ok("encodePng/decodePng 往返无损", () => {
  const w = 16;
  const h = 10;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      rgb[i] = x * 16;
      rgb[i + 1] = y * 25;
      rgb[i + 2] = 128;
    }
  }
  const back = decodePng(encodePng(w, h, rgb));
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.ok(back.data.equals(rgb));
});
ok("cropPngBottom 保留顶部 80%", () => {
  const w = 16;
  const h = 10;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      rgb[i] = x * 16;
      rgb[i + 1] = y * 25;
      rgb[i + 2] = 7;
    }
  }
  const png = encodePng(w, h, rgb);
  const cropped = cropPngBottom(png, 0.8);
  assert.equal(cropped.origHeight, 10);
  assert.equal(cropped.height, 8); // 10 × 0.8
  const img = decodePng(cropped.buffer);
  assert.equal(img.width, 16);
  assert.ok(img.data.equals(rgb.subarray(0, 8 * w * 3)), "顶部 8 行像素应与原图一致");
});
ok("cropPngBottom 对非 PNG 抛错", () => {
  assert.throws(() => cropPngBottom(Buffer.from("\xff\xd8\xff jpeg-ish")), /PNG/);
});
ok("parseExtendFrac 解析", () => {
  assert.equal(parseExtendFrac("1/4"), 0.25);
  assert.equal(parseExtendFrac("1/5"), 0.2);
  assert.equal(parseExtendFrac("0.2"), 0.2);
  assert.equal(parseExtendFrac(0.5), 0.5);
  assert.equal(parseExtendFrac(undefined), 0.25);
  assert.equal(parseExtendFrac("垃圾"), 0.25);
});

// ————— 杂项 —————
console.log("misc");
ok("normalizeRatio 白名单", () => {
  assert.equal(normalizeRatio("16:9"), "16:9");
  assert.equal(normalizeRatio("2:99"), "1:1");
  assert.equal(normalizeRatio("", "auto"), "auto");
});
ok("loadConfig 解析 DOUBAO_ACCOUNTS", () => {
  process.env.DOUBAO_ACCOUNTS = "主号:sessionid=abc123456789,ttwid=tt1;小号:sessionid=def123456789";
  const cfg = loadConfig();
  assert.equal(cfg.accounts.length, 2);
  assert.equal(cfg.accounts[0].name, "主号");
  assert.equal(cfg.accounts[0].ttwid, "tt1");
  assert.equal(cfg.accounts[1].name, "小号");
  assert.equal(cfg.model, DEFAULTS.model);
  delete process.env.DOUBAO_ACCOUNTS;
});
ok("loadConfig 过滤无效账号", () => {
  const cfg = loadConfig({ accounts: [{ name: "坏", sessionid: "x" }, { name: "好", sessionid: "valid-sessionid-123" }] });
  assert.equal(cfg.accounts.length, 1);
  assert.equal(cfg.accounts[0].name, "好");
});

// ————— 插件结构 —————
console.log("plugin structure");
ok("导出 generate_image 与 check_login 两个工具", async () => {
  const plugin = await DoubaoTools({}, {});
  const tools = plugin?.tool || {};
  assert.deepEqual(Object.keys(tools).sort(), ["check_login", "generate_image"]);
  const gi = tools.generate_image;
  assert.match(gi.description, /豆包/);
  assert.equal(gi.args.type, "object");
  assert.deepEqual(gi.args.required, ["prompt"]);
  assert.equal(gi.args.properties.ratio.enum.length, 6);
  assert.equal(typeof gi.execute, "function");
  assert.equal(typeof tools.check_login.execute, "function");
});
ok("未配置账号时 execute 返回可读错误而非抛异常", async () => {
  // 与真实 config.json 隔离：指向空配置文件
  const { writeFileSync, rmSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "doubao-test-"));
  const emptyCfg = path.join(dir, "config.json");
  writeFileSync(emptyCfg, "{}");
  const prev = process.env.DOUBAO_IMAGE_CONFIG;
  process.env.DOUBAO_IMAGE_CONFIG = emptyCfg;
  try {
    const plugin = await DoubaoTools({}, {});
    const out = await plugin.tool.generate_image.execute({ prompt: "测试" }, { directory: dir });
    assert.match(out, /未配置豆包账号/);
  } finally {
    if (prev === undefined) delete process.env.DOUBAO_IMAGE_CONFIG;
    else process.env.DOUBAO_IMAGE_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(process.exitCode ? "\n有测试失败" : `\n全部通过（${passed} 项）`);
