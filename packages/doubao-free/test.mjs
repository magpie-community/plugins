// Simple verification test for DoubaoFreeAuthPlugin
import assert from "node:assert"
import { DoubaoFreeAuthPlugin } from "./index.mjs"

async function runTests() {
  console.log("==> 1. Testing plugin factory creation...")
  assert.strictEqual(typeof DoubaoFreeAuthPlugin, "function", "Plugin must be a function")

  const pluginInstance = await DoubaoFreeAuthPlugin({ client: {} })
  assert.ok(pluginInstance.config, "Plugin must have config hook")
  assert.ok(pluginInstance.provider, "Plugin must have provider hook")
  assert.ok(pluginInstance.auth, "Plugin must have auth hook")
  console.log("✓ Plugin factory structure verified.")

  console.log("==> 2. Testing config hook injection...")
  const mockConfig = {}
  await pluginInstance.config(mockConfig)
  assert.ok(mockConfig.provider["doubao-free"], "Provider 'doubao-free' must be injected")
  assert.strictEqual(mockConfig.provider["doubao-free"].name, "Doubao Free (豆包)")
  assert.ok(mockConfig.provider["doubao-free"].models["doubao-pro-32k"], "doubao-pro-32k must be declared")
  console.log("✓ Config hook injection verified.")

  console.log("==> 3. Testing auth loader and friendly network error handling...")
  const loader = await pluginInstance.auth.loader(async () => ({
    baseURL: "http://127.0.0.1:59999/v1", // intentionally unused test port
    key: "sk-test",
  }))
  assert.ok(loader.baseURL, "Loader must return baseURL")
  assert.strictEqual(loader.apiKey, "sk-test", "Loader must return apiKey")
  assert.strictEqual(typeof loader.fetch, "function", "Loader must provide custom fetch")

  // Test fetch handling when service is down
  const response = await loader.fetch("http://127.0.0.1:59999/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "doubao-pro-32k", messages: [] }),
  })
  assert.strictEqual(response.status, 502, "Downstream connection failure should return 502")
  const json = await response.json()
  assert.ok(json.error.message.includes("无法连接到豆包免费网关"), "Error message should include friendly instructions")
  console.log("✓ Network diagnostics verified.")

  console.log("\n All tests passed successfully!")
}

runTests().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
