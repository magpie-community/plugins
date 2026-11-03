// @local/page-project-keys — Magpie key-cabinet plugin host entry.
// OpenCode 风格 default export；page.service 起本地 HTTP，沙盒页 location.replace 过来。

import { startServer } from "./lib/server.mjs";

const boots = new Map();

function bootServer(options = {}) {
  const port = Number(options.port) || Number(process.env.MAGPIE_PROJECT_KEYS_PORT) || 3491;
  if (!boots.has(port)) {
    const boot = startServer({ options: { ...options, port } })
      .then((info) => {
        console.log(`[page-project-keys] listening on http://127.0.0.1:${info.port}${info.reused ? " (reused)" : ""}`);
        return info;
      })
      .catch((err) => {
        console.error("[page-project-keys] could not start:", err?.message || err);
        boots.delete(port);
        return null;
      });
    boots.set(port, boot);
  }
  return boots.get(port);
}

// Magpie Warm / page HTML serve: 宿主加载模块后调用 server() 时才起服务。
// 单纯 import 这个文件不占端口（社区 CI 的 check.mjs 会 import 检查导出）。

export default {
  id: "page-project-keys",
  // Some hosts call a hook with options (port from magpie.page.service).
  async server(_input, options) {
    await bootServer(options && typeof options === "object" ? options : {});
    return {};
  },
};
