// magpie-free-tokens host part：仅在插件宿主启动时拉一次 AIHOT（不是每次打开页面）、读本机 magpie、写 page/data.js。
// 只导出 default {id, server}（不带任何命名导出，免得被 check.mjs 当插件函数调用）。
import { refresh } from "./src/refresh.js";

const server = async (input) => { await refresh(input); return {}; };
export default { id: "free-tokens", server };
