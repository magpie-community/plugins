// AIHOT 羊毛 → magpie 插件。一律用完整 npm 包名（magpie plugin add <npm>），不使用短名（短名可能指向被抢注的无作用域包）。
export const MAPPING = {
  "豆包": { pid: "doubao-work", npm: "@magpie-community/opencode-doubao-work-auth", name: "豆包工作", checkin: false },
  "Cloudflare": { pid: "cloudflare-workers-ai", npm: "@magpie-community/opencode-cloudflare-workers-ai-auth", name: "Cloudflare Workers AI", checkin: false },
  "MiniMax": { pid: "minimax-code", npm: "@magpie-community/opencode-minimax-auth", name: "MiniMax Code", checkin: true },
  "阿里云 Qoder": { pid: ["qoder", "qoder-cn"], npm: "@magpie-community/opencode-qoder-auth", name: "Qoder", checkin: true },
  "字节 TRAE": { pid: "trae-cn", npm: "@magpie-community/opencode-trae-auth", name: "Trae", checkin: true },
  "腾讯 WorkBuddy": { pid: "workbuddy", npm: "@magpie-community/opencode-workbuddy-auth", name: "WorkBuddy", checkin: true },
  "书生·端砚": { pid: "intern-inkstone", npm: "@magpie-community/opencode-inkstone-auth", name: "书生·端砚", checkin: true },
  "Zed": { pid: "zed", npm: "@magpie-community/opencode-zed-auth", name: "Zed", checkin: false },
  "华为云码道": { pid: "codearts", npm: "@magpie-community/opencode-codearts-auth", name: "CodeArts", checkin: true },
  "智谱 AutoClaw": { pid: "autoclaw-cn", npm: "@magpie-community/opencode-autoclaw-auth", name: "AutoClaw", checkin: true },
  "智谱 ZCode": { pid: "zcode", npm: "@magpie-community/opencode-zcode-auth", name: "ZCode", checkin: true },
  "商汤日日新": { pid: "sensenova-token-plan", npm: "@magpie-community/opencode-sensenova-auth", name: "SenseNova", checkin: false },
  "OpenCode": { pid: "opencode-zen-free", npm: "@magpie-community/opencode-zen-free-auth", name: "OpenCode Zen Free", checkin: false },
};
