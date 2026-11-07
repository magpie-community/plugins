import assert from "node:assert/strict"
import { rpc, serve, html, json, text, tempRoot, removeTempRoot } from "./test.mjs"

const root = await tempRoot()
let claims = 0
const fake = await serve(async (req, res) => {
  if (req.url.startsWith("/api/account/wallet/checkin")) {
    claims++
    return json(res, { rewardUnits: 100, streakDays: 4, balanceUnits: 8900 })
  }
  if (req.url === "/api/account/wallet") return json(res, { balanceUnits: 8800, checkin: { enabled: true, checkedInToday: true, streakDays: 3 }, user: { name: "fixture" } })
  if (req.url === "/api/public/models") return json(res, [{ id: "model-a", name: "Model A" }])
  if (req.url.startsWith("/app/wallet")) return text(res, html("<button>今日已签 · 连签 3 天</button><script>fetch('/api/account/wallet')</script>"))
  text(res, "not found", 404)
})
try {
  const h = await rpc(process.execPath, "/Users/liu/magpie/internal/plugin/host.js", {})
  const result = await h.call(1, "init", {
    authPath: `${root}/auth.json`, directory: root, modelsDevPath: "", plugins: [{ spec: "ccx", target: "/Users/liu/magpie/plugins/ccx" }], loadMillis: 5000, listMillis: 5000,
  })
  console.log("返回:", JSON.stringify(result, null, 2))
  assert.equal(result.plugins[0].error, undefined)
  assert.equal(result.plugins[0].provides[0], "ccx")
  console.log("供应商加载成功：", result.plugins[0].provides)
  await h.stop()
} finally {
  fake.server.close()
  await removeTempRoot(root)
}
