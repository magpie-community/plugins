// Magpie 工具插件入口：把用户自己的豆包账号（网页版登录态，与桌面端同账号同后端）
// 暴露为所有 Agent 可用的生图工具。经 /mcp/magpie/tools 注册为 <插件>_<工具>。
//
// 工具：
//   generate_image — 文生图 / 图生图（参考图），可指定比例与免费档模型
//   check_login    — 各账号登录态自检
//
// 账号来源（优先级从高到低，详见 src/config.mjs 顶部说明）：
//   1. magpie 登录态 —— 扫码登录后 magpie 存入 plugin-auth.json，工具执行时读回
//   2. env DOUBAO_ACCOUNTS="主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"
//   3. Magpie options 里的 accounts（magpie plugin options <插件> '<json>'）
//   4. env DOUBAO_IMAGE_CONFIG 指向的 JSON / 插件目录 config.json（手动填写，注意 0600 权限）
//
// 注意：本文件只导出这一个插件函数。Magpie 把每个导出函数都当作插件，
// 再加 default 导出会让同一 provider 注册两次（UI 会报"已登录但无法列出"）。
import path from "node:path";
import { loadConfig } from "./src/config.mjs";
import { generate, checkLogin, FREE_MODELS, DEFAULT_MODEL, RATIOS } from "./src/client.mjs";
import { DoubaoError } from "./src/http.mjs";
import { downloadImage, fileStamp, fileSize } from "./src/download.mjs";
import { qrLogin, saveQrPng, openInViewer } from "./src/qlogin.mjs";

// 插件 id：本地文件夹加载时取目录名，npm 包安装时取包名去掉 scope 与 tools- 前缀
const PLUGIN_ID = "doubao";

function resolveOutDir(args, context, cfg) {
  if (args.out_dir) return String(args.out_dir);
  if (cfg.outDir) return String(cfg.outDir);
  const base = context?.directory || context?.worktree || process.cwd();
  return path.join(String(base), "generated-images");
}

function failMessage(err) {
  if (err instanceof DoubaoError) {
    return `豆包生图失败：${err.message}${err.hint ? `\n建议：${err.hint}` : ""}`;
  }
  return `豆包生图失败：${err?.message || String(err)}`;
}

export const DoubaoTools = async (input, options) => {
  const pluginOptions = options && typeof options === "object" ? options : {};
  // input.directory 是 magpie 的配置目录（plugin-auth.json 所在处），扫码登录态从这里读回
  const magpieDir = input?.directory || "";

  return {
    tool: {
      generate_image: {
        description:
          "用用户自己的豆包账号生成图片（文生图/图生图，免费额度，Seedream 系列）。" +
          "当用户想要画图、生成图片、出插画/海报/示意图，且希望走豆包（豆包桌面端/网页版同账号）时使用。" +
          "输入画面描述 prompt（中英文皆可），可选画幅比例与模型档位；" +
          "给出参考图 ref_images 时按参考图风格/内容出图（图生图）。" +
          "返回已保存到本地的图片文件路径（含 Markdown 引用）。",
        args: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "画面描述，越具体越好（主体/场景/风格/光线/构图）",
            },
            ratio: {
              type: "string",
              enum: RATIOS,
              description: `画幅比例，默认 1:1，auto 交给豆包决定`,
            },
            model: {
              type: "string",
              description:
                `图片模型档位，默认 ${DEFAULT_MODEL}（免费档：${FREE_MODELS.join(" / ")}）。` +
                "Pro 档需要豆包订阅，免费账号会自动回退免费档",
            },
            ref_images: {
              type: "array",
              items: { type: "string" },
              description: "参考图（图生图）：本地图片文件（png/jpg/webp/gif）或公网图片 URL，可多张",
            },
            account: {
              type: "string",
              description: "要使用的账号名（可选，默认用第一个账号；仅按账号名匹配）",
            },
            out_dir: {
              type: "string",
              description: "图片保存目录，默认当前项目下的 generated-images/",
            },
          },
          required: ["prompt"],
        },
        async execute(args, context) {
          const cfg = loadConfig(pluginOptions, magpieDir, PLUGIN_ID);
          try {
            const result = await generate(cfg, {
              prompt: String(args.prompt || ""),
              ratio: args.ratio,
              model: args.model,
              refImages: args.ref_images,
              account: args.account,
            });
            const dir = resolveOutDir(args, context, cfg);
            const stamp = fileStamp();
            const saved = [];
            for (let i = 0; i < result.images.length; i++) {
              const { file, bytes } = await downloadImage(
                result.images[i].url,
                dir,
                `doubao-${stamp}-${i + 1}`,
              );
              saved.push({ file, bytes });
            }
            const lines = saved.map(
              (s, i) => `${i + 1}. ${s.file}（${(s.bytes / 1024).toFixed(0)} KB）`,
            );
            return (
              `已通过豆包生成 ${saved.length} 张图片。\n` +
              `账号 ${result.account} · ${result.channel === "web" ? "网页通道" : "客户端通道"}${
                result.conversationId ? ` · 会话 ${result.conversationId}` : ""
              }${result.text ? `\n${result.text.slice(0, 200)}` : ""}\n` +
              `文件：\n${lines.join("\n")}\n\n` +
              saved.map((s, i) => `[生成图 ${i + 1}](${s.file})`).join(" · ")
            );
          } catch (err) {
            return failMessage(err);
          }
        },
      },
      check_login: {
        description:
          "检查豆包生图插件的账号配置与登录态：列出每个配置账号是否存活。生图报登录失效/风控时先跑这个。",
        args: { type: "object", properties: {} },
        async execute() {
          const cfg = loadConfig(pluginOptions, magpieDir, PLUGIN_ID);
          if (!cfg.accounts.length) {
            return (
              "尚未配置任何豆包账号。请在 Magpie 插件页点击「登录」扫码，或设置环境变量 " +
              "DOUBAO_ACCOUNTS=\"主号:sessionid=xxx\"（也可手动填写 config.json，参考 config.example.json）。"
            );
          }
          const statuses = await checkLogin(cfg);
          const lines = statuses.map((s) =>
            s.live
              ? `✅ ${s.name} — 登录有效${s.userName ? `（${s.userName}）` : ""}${s.userId ? `，user_id=${s.userId}` : ""}`
              : `❌ ${s.name} — 登录无效${s.error ? `（${s.error}）` : "，请重新扫码登录或更新 sessionid"}`,
          );
          return `豆包账号共 ${statuses.length} 个：\n${lines.join("\n")}`;
        },
      },
    },
    // 扫码登录：magpie plugin login doubao（或插件页「登录」按钮）时触发。
    // 豆包没有 OAuth，采用与 doubao2api 相同的二维码扫码流：弹出二维码图片 →
    // 用户手机豆包 App 扫码确认 → 轮询拿到登录态。凭证交给 magpie 保管
    // （magpie 写入 plugin-auth.json，0600），插件自身不再另存凭证文件。
    auth: {
      provider: PLUGIN_ID,
      single: true, // 账号在插件 config/env 里管理，magpie 侧只存这一份扫码登录态
      methods: [
        {
          type: "oauth",
          label: "豆包扫码登录",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions:
              "将弹出豆包登录二维码（系统看图程序）。请用手机豆包 App 扫码并在手机上确认；" +
              "登录态由 magpie 保管，插件不另存凭证文件。远程（magpie web）使用时若看不到二维码，" +
              "请在运行 magpie 的机器上操作一次，或改用 DOUBAO_ACCOUNTS 环境变量。",
            callback: async () => {
              try {
                const result = await qrLogin({
                  onStatus: (stage, detail) => {
                    if (stage === "ready" && Buffer.isBuffer(detail)) openInViewer(saveQrPng(detail));
                  },
                });
                // magpie 的 save() 契约：结果带 key（或 refresh）才会持久化。
                // key = sessionid（存为 type:"api"），其余凭证进 metadata。
                return {
                  type: "success",
                  // 展示名用昵称/user_id，不暴露 sessionid
                  accountId: result.userName || (result.userId ? `豆包用户 ${result.userId}` : "豆包账号"),
                  key: result.sessionid,
                  metadata: {
                    ttwid: result.ttwid || "",
                    passport_csrf_token: result.passport_csrf_token || "",
                    deviceId: result.deviceId || "",
                    webId: result.webId || "",
                  },
                };
              } catch (err) {
                return { type: "failed", error: `豆包扫码登录失败：${err?.message || err}` };
              }
            },
          }),
        },
      ],
    },
  };
};
