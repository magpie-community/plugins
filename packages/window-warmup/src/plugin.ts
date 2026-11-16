// 宿主入口：magpie 加载本包并调用 server() 时启动本地服务（每个端口只起一次）。
// 单纯 import 不占端口、不读写磁盘；启动失败清掉对应单例，宿主下次调用可重试。
// 启动前先探测端口：响应带本插件的自标记头（server.ts 所有响应都带 x-window-warmup: 1）
// → 已有本服务在跑（多半是正在换下的上一个宿主），先返回 {}，在后台等它松手再起来；
// 没探测到才当场启动，端口被别的程序占用时 Bun.serve 仍抛原错误。
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
/** 正在等上一个宿主松手的端口：每个端口只等一份 */
const waiting = new Set<number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inUse = (e: unknown) => (e as { code?: string } | null)?.code === "EADDRINUSE";

/** 起服务（迁移 + startService）；失败清掉单例，下次可重试 */
function start(listen: number, dir: string): Promise<ServiceHandle> {
  let instance = instances.get(listen);
  if (!instance) {
    instance = (async () => {
      // 首次启动（新目录还没有 state.json）时把旧包的数据接过来；迁移在打开 store 之前完成
      await migrateLegacyState(dir);
      return startService({ port: listen, dir, base: gatewayBase() });
    })().catch((e: unknown) => {
      instances.delete(listen);
      throw e;
    });
    instances.set(listen, instance);
  }
  return instance;
}

/**
 * 端口上是本插件的另一个服务：多半是 magpie 正在换下的上一个宿主，手上还有调用要跑完
 * （1 到 10 多秒，最长 10 分钟），端口和 service.lock 都在它手里。以前这里直接返回 {}，
 * 旧宿主一退出 3492 上就谁也没有，调度也停了，直到下次换宿主（#1227）。现在在后台
 * 每秒探一次：它不再应答就整套起来（抢锁 + 绑端口 + 调度）。它还在应答就一直等，
 * 一直在跑的另一份服务也只是让这里多等，不会抢它的锁。
 */
function startWhenFree(listen: number, dir: string): void {
  if (waiting.has(listen)) return;
  waiting.add(listen);
  void (async () => {
    try {
      for (;;) {
        await sleep(1000);
        if (instances.has(listen)) return;
        if (await alreadyServing(listen)) continue;
        try {
          await start(listen, dir);
          console.log(`[window-warmup] 上一个宿主已松手，${listen} 接上了`);
          return;
        } catch (e) {
          // 刚不应答、端口还没放：下一秒再试；别的错误报出来，不再空转
          if (!inUse(e)) {
            console.error(`[window-warmup] ${listen} 起不来：${e instanceof Error ? e.message : String(e)}`);
            return;
          }
        }
      }
    } finally {
      waiting.delete(listen);
    }
  })();
}

export default {
  id: "magpie-window-warmup",
  /** magpie 宿主入口；options.port 来自 package.json 的 magpie.options */
  server: async (_input: unknown, opts: { port?: number } = {}) => {
    const port = Number(opts?.port);
    const listen = Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
    // 数据目录在这里定下：后台接手时用的也是这一份
    const dir = defaultDir();
    if (!instances.has(listen) && (await alreadyServing(listen))) {
      console.log(`[window-warmup] ${listen} 被上一个宿主占着，它一松手就接上`);
      startWhenFree(listen, dir);
      return {};
    }
    await start(listen, dir);
    return {};
  },
};
