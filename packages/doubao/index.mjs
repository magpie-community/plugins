// Magpie 工具插件入口：把用户自己的豆包账号（网页版登录态，与桌面端同账号同后端）
// 暴露为所有 Agent 可用的生图工具。经 /mcp/magpie/tools 注册为 <插件>_<工具>。
//
// 工具：
//   generate_image — 文生图 / 图生图（参考图），可指定比例与免费档模型
//   check_login    — 各账号登录态自检
//
// 凭证配置（任选其一，优先级从高到低）：
//   1. env DOUBAO_IMAGE_CONFIG 指向的 JSON 文件
//   2. 本插件目录下的 config.json（参考 config.example.json）
//   3. env DOUBAO_ACCOUNTS="主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"
//   4. Magpie options（magpie plugin options tools-doubao '<json>'）
import path from "node:path";
import { loadConfig } from "./src/config.mjs";
import { generate, checkLogin, FREE_MODELS, DEFAULT_MODEL, RATIOS } from "./src/client.mjs";
import { DoubaoError } from "./src/http.mjs";
import { downloadImage, fileStamp, fileSize } from "./src/download.mjs";
import { qrLogin, saveQrPng, openInViewer, writeAccountToConfig } from "./src/qlogin.mjs";
import { removeWatermarkByExtend } from "./src/watermark.mjs";

// 本地文件夹加载时 Magpie 用目录名作为插件 id（工具前缀也来自它）
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
              description: "参考图（图生图）：本地文件路径或图片 URL，可多张",
            },
            out_dir: {
              type: "string",
              description: "图片保存目录，默认当前项目下的 generated-images/",
            },
            remove_watermark: {
              type: "boolean",
              description:
                "去除右下角“豆包AI生成”水印：生成后自动以原图为参考追加“往下扩图四分之一”再生成一次，" +
                "并把底部扩出部分裁掉（多花一次生成额度，画面边缘会被重新演绎）。" +
                "不传则跟随配置 removeWatermark（默认关闭）",
            },
          },
          required: ["prompt"],
        },
        async execute(args, context) {
          const cfg = loadConfig(pluginOptions);
          const removeWm =
            args.remove_watermark !== undefined
              ? Boolean(args.remove_watermark)
              : Boolean(cfg.removeWatermark);
          try {
            const genOpts = {
              prompt: String(args.prompt || ""),
              ratio: args.ratio,
              model: args.model,
              refImages: args.ref_images,
              account: args.account,
            };
            const result = await generate(cfg, genOpts);
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
            // 去水印（扩图裁剪法）：仅对文生图生效；图生图保留用户原图语义，不自动扩图
            let wmNote = "";
            if (removeWm && !args.ref_images?.length) {
              for (const s of saved) {
                try {
                  const r = await removeWatermarkByExtend(cfg, {
                    file: s.file,
                    prompt: genOpts.prompt,
                    ratio: args.ratio,
                    account: args.account,
                  });
                  wmNote += `\n[去水印] 已扩图${Math.round(r.extendFrac * 100)}%并裁剪：${r.width}×${r.height}（扩图前 ${r.width}×${r.origHeight}）`;
                } catch (err) {
                  wmNote += `\n[去水印] 失败，已保留带水印原图：${err?.message || err}`;
                  break;
                }
              }
            }
            for (const s of saved) s.bytes = await fileSize(s.file);
            const lines = saved.map(
              (s, i) => `${i + 1}. ${s.file}（${(s.bytes / 1024).toFixed(0)} KB）`,
            );
            return (
              `已通过豆包生成 ${saved.length} 张图片。\n` +
              `账号 ${result.account} · ${result.channel === "web" ? "网页通道" : "客户端通道"}${
                result.conversationId ? ` · 会话 ${result.conversationId}` : ""
              }${result.text ? `\n${result.text.slice(0, 200)}` : ""}${wmNote}\n` +
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
          const cfg = loadConfig(pluginOptions);
          if (!cfg.accounts.length) {
            return (
              "尚未配置任何豆包账号。请让用户运行 `node scripts/login.mjs` 扫码登录，或把 doubao.com 网页版 Cookie 里的 sessionid 写入插件目录的 " +
              "config.json（参考 config.example.json），或设置环境变量 DOUBAO_ACCOUNTS=\"主号:sessionid=xxx\"。"
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
    // 扫码登录：magpie plugin login doubao-image-plugin 时触发。
    // 豆包没有 OAuth，采用与 doubao2api 相同的二维码扫码流：
    // 弹出二维码图片 → 用户手机豆包 App 扫码确认 → 轮询拿到 sessionid 写入 config.json。
    auth: {
      provider: PLUGIN_ID,
      methods: [
        {
          type: "oauth",
          label: "豆包扫码登录",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions:
              "将弹出豆包登录二维码（系统看图程序）。请用手机豆包 App 扫码并在手机上确认，登录态会自动写入插件 config.json。",
            callback: async () => {
              try {
                const result = await qrLogin({
                  onStatus: (stage, detail) => {
                    if (stage === "ready" && Buffer.isBuffer(detail)) openInViewer(saveQrPng(detail));
                  },
                });
                const file = writeAccountToConfig(result, "扫码登录");
                return { type: "success", accountId: `豆包 · ${result.sessionid.slice(0, 6)}…`, configFile: file };
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

export default DoubaoTools;
