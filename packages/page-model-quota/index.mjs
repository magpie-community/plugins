// 插件的宿主部分：magpie 的 Bun 宿主加载本模块，向它要页面服务。
// 服务跑在这个宿主进程里，magpie 停掉插件时一起停。
import { startServer } from "./lib/server.mjs";

let started = null;

export default {
  id: "magpie-model-quota",
  server: async (input, options) => {
    if (!started) {
      // 端口 0 或非法值归成 undefined：页面从同一份 options 读到的与这里一致。
      const value = Number(options?.port);
      const port = Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
      started = startServer({
        port,
        configDir: input?.directory,
      }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
