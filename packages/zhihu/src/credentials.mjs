// Access Secret 的取法，优先级与社区插件一致：
//   插件选项 accessSecret > 环境变量 ZHIHU_ACCESS_SECRET > magpie 里保存的登录
// 后两者都不会出现在插件日志或错误信息里。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDER } from "./config.mjs";

const clean = (value) => {
  if (typeof value !== "string") return undefined;
  // 用户可能把文档里的 "Bearer xxx" 整段粘进来。
  const key = value.trim().replace(/^Bearer\s+/i, "").trim();
  return key || undefined;
};

export class Credentials {
  constructor(input, options = {}) {
    this.directory = input?.directory ?? process.cwd();
    this.options = options ?? {};
  }

  // 插件选项与环境变量，优先于 magpie 里的登录。
  override() {
    return clean(this.options.accessSecret) ?? clean(process.env.ZHIHU_ACCESS_SECRET);
  }

  // 读取 magpie 的 plugin-auth.json：{"zhihu":{"type":"api","key":"…"}}
  async stored() {
    let raw;
    try {
      raw = await readFile(join(this.directory, "plugin-auth.json"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("magpie 的 plugin-auth.json 无法解析，请先恢复它再重新登录。");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const auth = value[PROVIDER];
    if (!auth || typeof auth !== "object") return undefined;
    if (typeof auth.key === "string") return clean(auth.key);
    return undefined;
  }

  // 没有配置任何登录信息时给出可操作的提示。
  async token() {
    const key = this.override() ?? (await this.stored());
    if (!key) {
      throw new Error(
        "尚未配置知乎 Access Secret。请运行 `magpie plugin login zhihu`，" +
          "或在插件选项里填写 accessSecret，或设置环境变量 ZHIHU_ACCESS_SECRET。",
      );
    }
    return key;
  }

  // 工具调用与 magpie 自己的联网搜索共用：magpie 选定账号时（ctx.getAuth）
  // 用那个账号，这样被拒绝的账号能被 magpie 正确标记。
  async tokenFor(ctx) {
    if (typeof ctx?.getAuth === "function") {
      const auth = await ctx.getAuth();
      const key = auth?.type === "api" ? clean(auth.key) : undefined;
      if (key) return key;
      // magpie 明确给了“没有账号”时不要偷偷用别的凭据。
      if (auth) return this.token();
    }
    return this.token();
  }
}