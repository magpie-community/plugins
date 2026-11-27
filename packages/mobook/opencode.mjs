// 包的 OpenCode 1.x 插件面：OpenCode 1.x 与 magpie 的插件宿主只接受插件函数
// （导出里只要有一个非函数，1.x 就拒绝加载整包）。OpenCode 2.x 载入 opencode2.mjs，
// 由它运行这里的插件。
export { MoBookAuthPlugin } from './index.mjs'
