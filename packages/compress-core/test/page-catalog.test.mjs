// page/engines.js 是提交进仓库的生成物：它小、能从 catalog.js 逐字节重建，所以
// 允许它在仓库里。这个测试把「catalog.js 或某个引擎的 configSchema 改了，而
// page/engines.js 没跟着改」变成一条红。
import { check } from "./helpers.mjs"
import { pageCatalogSource, committedPageCatalog } from "../scripts/gen-page-catalog.mjs"
import { ENGINES } from "../catalog.js"

export const name = "page-catalog"

function firstDifference(a, b) {
  if (a === b) return ""
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `第 ${i} 个字符起不同：${JSON.stringify(a.slice(i, i + 40))} 对 ${JSON.stringify(b.slice(i, i + 40))}`
    }
  }
  return `长度不同：${a.length} 对 ${b.length}`
}

export async function run() {
  const generated = pageCatalogSource()
  const committed = committedPageCatalog()
  check("page/engines.js 与 catalog.js 逐字节一致（跑 node scripts/gen-page-catalog.mjs 重建）", generated === committed, firstDifference(generated, committed))

  const parsed = JSON.parse(generated.replace(/^\/\/[^\n]*\n/, "").replace(/^globalThis\.CompressCatalog = /, "").replace(/;\n$/, ""))
  check("每个引擎都在页面目录里", parsed.engines.length === ENGINES.length, `${parsed.engines.length} 对 ${ENGINES.length}`)
  check("页面目录里没有 enabled 字段（面板自己画开关）", parsed.engines.every((e) => e.fields.every((f) => f.key !== "enabled")))
  check("页面沙箱不会加载 module，所以文件开头必须是自己挪不动的那句注释", committed.startsWith("// 由 scripts/gen-page-catalog.mjs 生成"))
}