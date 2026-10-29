// 独立启动对话服务，不依赖 magpie 的插件宿主。
// 用法：node serve.mjs   （或双击 start-server.cmd）
//
// 如果 magpie 已经通过插件把服务起起来了，这里就什么都不做直接退出，
// 避免两个实例抢同一份设置和对话文件。
import { startServer } from "./lib/server.mjs";

const CANDIDATES = [3477, 3478, 3479, 3480];

async function alreadyRunning() {
  for (const p of CANDIDATES) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      const res = await fetch("http://127.0.0.1:" + p + "/api/ping", { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.ok) return { port: p, version: j.version };
      }
    } catch { /* 这个端口没有 */ }
  }
  return null;
}

const alive = await alreadyRunning();
if (alive) {
  console.log("");
  console.log("  对话服务已经在运行了");
  console.log("  地址: http://127.0.0.1:" + alive.port + "  (版本 " + (alive.version || "?") + ")");
  console.log("  不需要再起一个，直接去 magpie 里打开「对话」即可。");
  console.log("");
  process.exit(0);
}

const info = await startServer({ configDir: process.env.MAGPIE_CHAT_CONFIG || "", options: {} })
  .catch((err) => {
    console.error("启动失败:", err?.message || err);
    process.exit(1);
  });

console.log("");
console.log("  对话服务已就绪");
console.log("  地址: http://127.0.0.1:" + info.port);
console.log("  这个窗口最小化即可，关掉服务就停了");
console.log("");

process.on("SIGINT", async () => { await info.close(); process.exit(0); });
