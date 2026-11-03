// 宿主入口：magpie 加载本包并调用 server() 时启动本地服务（每个端口只起一次）。
// 单纯 import 不占端口、不读写磁盘；启动失败清掉对应单例，宿主下次调用可重试。
// 启动前先探测端口：响应带本插件的自标记头（server.ts 所有响应都带 x-window-warmup: 1）
// → 已有本服务在跑，直接返回 {}（不重开数据目录、不迁移、不报错）；没探测到才真正启动，
// 端口被别的程序占用时 Bun.serve 仍抛原错误。
import { join } from "node:path";
import { gatewayBase } from "./gateway";
import { xdgConfigHome } from "./magpie-files";
import { alreadyServing, startService, type ServiceHandle } from "./server";
import { migrateLegacyState } from "./store";

/** 默认服务端口，与 package.json 的 magpie.options 和带路页（page/boot.js）一致 */
export const DEFAULT_PORT = 3492;

/** 数据目录：WINDOW_WARMUP_DIR 优先，否则 XDG 配置目录下的 magpie/window-warmup。
 * 不导出：宿主会把模块导出的每个函数都当插件函数调（scripts/check.mjs 的约定） */
function defaultDir(env: Record<string, string | undefined> = process.env): string {
  const custom = env.WINDOW_WARMUP_DIR?.trim();
  if (custom) return custom;
  return join(xdgConfigHome(env), "magpie", "window-warmup");
}

/** 端口 → 启动中的服务；按端口分键，端口改了旧实例也不串 */
const instances = new Map<number, Promise<ServiceHandle>>();

export default {
  id: "magpie-window-warmup",
  /** magpie 宿主入口；options.port 来自 package.json 的 magpie.options */
  server: async (_input: unknown, opts: { port?: number } = {}) => {
    const port = Number(opts?.port);
    const listen = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
    if (await alreadyServing(listen)) return {};
    let instance = instances.get(listen);
    if (!instance) {
      instance = (async () => {
        const dir = defaultDir();
        // 首次启动（新目录还没有 state.json）时把旧包的数据接过来；迁移在打开 store 之前完成
        await migrateLegacyState(dir);
        return startService({
          port: listen,
          dir,
          base: gatewayBase(),
        });
      })().catch((e: unknown) => {
        instances.delete(listen);
        throw e;
      });
      instances.set(listen, instance);
    }
    await instance;
    return {};
  },
};
