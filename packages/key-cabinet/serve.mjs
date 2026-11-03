// 本地开发用：直接起宿主服务（Magpie 里由插件宿主调用 index.mjs 的 server()）。
import plugin from "./index.mjs";

await plugin.server({}, {});
