// 兼容入口：`node test/run.mjs` 仍会执行全部用例。
// 真正的用例在 plugin.test.mjs（node:test 风格，同时可被 bun test 发现），
// 这里是薄壳，只做 import 触发执行。
import './plugin.test.mjs'
