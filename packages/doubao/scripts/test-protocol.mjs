#!/usr/bin/env node
// 独立协议测试脚本：不经 Magpie，直接调用豆包接口验证配置与生图链路。
//   node scripts/test-protocol.mjs --check                     # 检查各账号登录态
//   node scripts/test-protocol.mjs "一只柴犬在樱花树下"         # 文生图
//   node scripts/test-protocol.mjs "改成赛博朋克风格" --ref a.png --ref b.jpg
//   可选：--ratio 16:9  --model "Seedream 4.5"  --channel web|pc  --out 目录  --account 主号
import path from "node:path";
import { loadConfig, configSource } from "../src/config.mjs";
import { generate, checkLogin } from "../src/client.mjs";
import { removeWatermarkByExtend } from "../src/watermark.mjs";
import { downloadImage, fileStamp } from "../src/download.mjs";

function parseArgv(argv) {
  const opts = { refs: [], prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--ratio") opts.ratio = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--channel") opts.channel = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--account") opts.account = argv[++i];
    else if (a === "--ref") opts.refs.push(argv[++i]);
    else if (a === "--wm") opts.wm = true;
    else if (a === "--no-hint") opts.noHint = true;
    else if (!a.startsWith("--")) opts.prompt += (opts.prompt ? " " : "") + a;
  }
  return opts;
}

const args = parseArgv(process.argv.slice(2));
const cfg = loadConfig(args.noHint ? { ratioHint: false } : {});
if (args.channel) cfg.channel = args.channel;

console.log(`配置来源: ${configSource()}；账号 ${cfg.accounts.length} 个；通道 ${cfg.channel}；默认模型 ${cfg.model}`);

if (!cfg.accounts.length) {
  console.error(
    "未配置账号。请先创建 config.json（复制 config.example.json 并填入 sessionid），\n" +
      "或设置环境变量 DOUBAO_ACCOUNTS=\"主号:sessionid=xxx\"。",
  );
  process.exit(1);
}

if (args.check) {
  const statuses = await checkLogin(cfg);
  for (const s of statuses) {
    console.log(
      `${s.live ? "✅ 存活" : "❌ 失效"}  ${s.name}${s.userName ? ` (${s.userName})` : ""}` +
        `${s.userId ? ` user_id=${s.userId}` : ""}${s.error ? ` 错误: ${s.error}` : ""}`,
    );
  }
  process.exit(statuses.some((s) => s.live) ? 0 : 2);
}

if (!args.prompt) {
  console.error('用法: node scripts/test-protocol.mjs "提示词" [--ratio 16:9] [--model ...] [--ref 文件] [--check]');
  process.exit(1);
}

console.log(`开始生成（prompt="${args.prompt}", ratio=${args.ratio || cfg.ratio}, model=${args.model || cfg.model}${args.refs.length ? `, 参考图 ${args.refs.length} 张` : ""}）…`);
const started = Date.now();
try {
  const result = await generate(cfg, {
    prompt: args.prompt,
    ratio: args.ratio,
    model: args.model,
    refImages: args.refs,
    account: args.account,
  });
  console.log(`生成完成（${((Date.now() - started) / 1000).toFixed(1)}s，通道 ${result.channel}，账号 ${result.account}）`);
  if (result.conversationId) console.log(`会话: ${result.conversationId}`);
  if (result.text) console.log(`附言: ${result.text.slice(0, 200)}`);
  const outDir = args.out || path.resolve(import.meta.dirname, "..", "output");
  for (let i = 0; i < result.images.length; i++) {
    const img = result.images[i];
    const { file, bytes } = await downloadImage(img.url, outDir, `doubao-${fileStamp()}-${i + 1}`);
    console.log(`图片 ${i + 1}: ${file} (${(bytes / 1024).toFixed(0)} KB, ${img.width || "?"}x${img.height || "?"})`);
    if (args.wm && !args.refs.length) {
      console.log("去水印：扩图+裁剪中…");
      const r = await removeWatermarkByExtend(cfg, {
        file,
        prompt: args.prompt,
        ratio: args.ratio,
        account: args.account,
      });
      console.log(`  完成：${r.width}x${r.height}（扩图前 ${r.width}x${r.origHeight}，扩图比例 ${Math.round(r.extendFrac * 100)}%）`);
    }
  }
} catch (err) {
  console.error(`生成失败: ${err.message}`);
  if (err.hint) console.error(`建议: ${err.hint}`);
  process.exit(1);
}
