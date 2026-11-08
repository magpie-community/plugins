// magpie 窗口里的「用量看板」页面。
//
// 两层结构（同 Magiczerowxy/magpie-chat、magpie-community/page-usage-tree 的做法）：
//   1. 本文件作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载。模块导入必须零副作用
//      （社区 scripts_check.mjs 会直接 import 做静态检查，导入即监听会占端口、写配置）；
//      服务只在 magpie 调用 server(input, options) 时启动，且 await 到真正监听后才返回。
//   2. page/index.html + page/boot.js 是 magpie 托管的「带路页」：优先跳
//      window.magpie.service（magpie web 在自己域名下的转发路径，页面留在 magpie
//      origin、由 magpie 自己的 key 保护），桌面回退 http://127.0.0.1:3455/。
//      服务端把口令注入返回的看板（window.__KEY__），只有 API 路由校验它。
//
// 服务已在本机跑着（另一个插件实例 / 手动 node）时端口占用，server.mjs 会静默复用。
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
let starting = null;

const plugin = {
  id: "magpie-usage-board",
  server: async (_input, options) => {
    if (!starting) {
      // manifest options（page.service.option = "port" 时 options.port 由 magpie 注入）
      // → startServer() 内部再回退到环境变量/默认值
      starting = import(pathToFileURL(path.join(here, "server.mjs")).href)
        .then((m) => m.startServer({
          port: options?.port,
          attribution: options?.attribution,
          remoteCallers: options?.remoteCallers,
          remoteProviders: options?.remoteProviders,
        }))
        .then((port) => ({ ok: true, port }))
        .catch((err) => {
          starting = null; // 允许 magpie 下次调用重试
          console.error("[magpie-usage-board] server not started:", err?.message || err);
          throw err;
        });
    }
    await starting;
    // 返回 { ok, port }：magpie 只要 await 成功即可，多出的字段便于测试与排障
    return await starting;
  },
};

export default plugin;

// 手动启动入口：node index.mjs（与 server.mjs 直跑等价，走同一生命周期契约）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  plugin.server().catch((e) => {
    console.error(`[magpie-usage-board] not started: ${e?.message || e}`);
    process.exit(1);
  });
}
