#!/usr/bin/env node
// 扫码登录：弹出豆包登录二维码（终端 ASCII + 系统看图程序），手机确认后自动把
// 登录态写入插件目录 config.json。等价于其他反代项目的 "QR 扫码登录"。
//   node scripts/login.mjs [--name 主号]
import { qrLogin, qrPngToAscii, saveQrPng, openInViewer, writeAccountToConfig } from "../src/qlogin.mjs";

const argv = process.argv.slice(2);
const nameIdx = argv.indexOf("--name");
const accountName = nameIdx >= 0 ? argv[nameIdx + 1] : "扫码登录";

console.log("正在获取豆包登录二维码…");
try {
  const result = await qrLogin({
    onStatus: (stage, detail) => {
      if (stage === "ready" && Buffer.isBuffer(detail)) {
        const file = saveQrPng(detail);
        const opened = openInViewer(file);
        console.log(`二维码已保存: ${file}${opened ? "（已用看图程序打开）" : "（请手动打开）"}\n`);
        const ascii = qrPngToAscii(detail);
        if (ascii) console.log(ascii);
        console.log("请用手机豆包 App 扫描二维码，并在手机上确认登录…");
      } else if (stage === "scanned") {
        console.log("已扫码，请在手机上点「确认」…");
      }
    },
  });
  const file = writeAccountToConfig(result, accountName);
  console.log(`\n✅ 登录成功，账号「${accountName}」已写入 ${file}`);
  console.log(`sessionid: ${result.sessionid.slice(0, 10)}…（完整值已保存，不会打印）`);
  console.log("现在可以直接在任意 Agent 里调用 doubao_generate_image 了。");
} catch (err) {
  console.error(`\n❌ 登录失败: ${err.message}`);
  process.exit(1);
}
