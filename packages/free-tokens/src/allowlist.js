// 只展示 AIHOT 上「厂商/平台自己的官方额度」，不展示第三方中转站。
// 新增官方厂商需在此登记；不在名单里的 provider 一律不发到页面（安全默认拒绝）。
export const OFFICIAL_PROVIDERS = new Set([
  "豆包", "华为云 OfficeAce", "商汤小浣熊", "腾讯 ima",
  "Cloudflare", "fal", "MiniMax", "阿里云 Qoder", "字节 TRAE", "腾讯 WorkBuddy",
  "WPS 灵犀", "蚂蚁百灵", "腾讯 EdgeOne", "书生·端砚", "腾讯云 ADP",
  "ElevenLabs", "Zed", "百度千帆", "阿里云百炼", "超算互联网", "DeepSeek",
  "腾讯云 TokenHub", "火山方舟", "华为云码道", "腾讯云开发", "智谱 AutoClaw",
  "智谱 ZCode", "商汤日日新", "OpenCode", "阶跃星辰", "SoMark",
]);
