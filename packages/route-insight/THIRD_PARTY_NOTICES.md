# 第三方声明

## lmfpd-sdk（lm-detector 的 SDK）

- 出处：npm `lmfpd-sdk@0.2.0`（MIT），上游项目 https://github.com/Ikaleio/lm-detector
- 版权人：以随包许可证原文为准 —— `lib/lmfpd/LICENSE` 写的是 **Copyright (c) 2026 xqy2006**（MIT）。这个包的 npm 元数据把项目挂在 Ikaleio 名下，但许可证里的版权人是 xqy2006；此处按许可证原文署名，不再简称「by Ikaleio」。
- 对应关系：`lib/lmfpd/index.js` 是那份 npm 包的 `dist/index.js` 逐字节拷贝（MIT 允许，且不引入运行时依赖），可从 npm tarball 核对：`dist.integrity` 的 sha256 前缀 `3c17ea64…`、`gitHead 1e58ed83`、版本 0.2.0。
- 用途：数值指纹（把「数数」样本的统计纹理对到具体型号）。
- 改动：无。只改了调用方（`lib/numeric.mjs` 传 `source` 钉版本、`ttl` 设成一年、`maxTokens` 封顶），vendored 代码本身没动。
- 许可证原文随包：`lib/lmfpd/LICENSE`（也在 `package.json` 的 `files` 里，`lib/` 整个目录会发布）。

## Veridrop

- 出处：https://github.com/canarybyte/veridrop （AGPL-3.0）
- 用途：**只参考它的检测维度与方法**（回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性）。
- AGPL-3.0 与 MIT 不兼容，所以 `lib/relay.mjs` 是照公开方法用 JavaScript 重新实现的，**没有复制它的任何代码**。
