import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SAPAICorePlugin } from "./src/index.js"

const AI_ROOT = "https://api.ai.eu10.hana.ondemand.com"
const CREDS = {
  authUrl: "https://synthetic.authentication.eu10.hana.ondemand.com",
  baseUrl: AI_ROOT,
  clientId: "synthetic-id",
  clientSecret: "synthetic-secret",
  resourceGroup: "default",
}
const CONFIG_ID = "c" + "0".repeat(15)
const DEPLOYMENT_ID = "d0000000000000a1"
const MODEL = "gpt-6-astra"
const VERSION = "2026-09-03"

const DEPLOYMENTS = {
  count: 1,
  resources: [{
    id: DEPLOYMENT_ID,
    status: "RUNNING",
    deploymentUrl: AI_ROOT + "/v2/inference/deployments/" + DEPLOYMENT_ID,
    configurationId: CONFIG_ID,
    details: { resources: { backendDetails: { model: { name: MODEL, version: VERSION } } } },
  }],
}
const CONFIGURATIONS = {
  [CONFIG_ID]: {
    id: CONFIG_ID,
    scenarioId: "foundation-models",
    executableId: "azure-openai",
    parameterBindings: [{ key: "modelName", value: MODEL }, { key: "modelVersion", value: VERSION }],
  },
}
const CATALOG = {
  count: 1,
  resources: [{
    model: MODEL,
    executableId: "azure-openai",
    allowedScenarios: [{ scenarioId: "foundation-models", executableId: "azure-openai" }],
    versions: [{ name: VERSION, contextLength: 1050000, inputTypes: ["text"], deprecated: false, retirementDate: "", streamingSupported: true }],
  }],
}

const json = payload => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })

test("SAP AI Core plugin: config, pre-network credential refusal, synthetic GPT discovery, warm destination guard", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "sap-aicore-smoke-"))
  const realFetch = globalThis.fetch
  let calls = 0
  let unexpected = null
  globalThis.fetch = async (href, init) => {
    calls++
    const request = href instanceof Request ? href : null
    const url = new URL(String(request ? request.url : href))
    const method = init?.method ?? request?.method ?? "GET"
    if (url.href === CREDS.authUrl + "/oauth/token" && method === "POST") return json({ access_token: "synthetic-token", token_type: "bearer", expires_in: 43199 })
    if (url.origin === AI_ROOT && method === "GET") {
      if (url.pathname === "/v2/lm/deployments") return url.searchParams.get("$skip") === "0" ? json(DEPLOYMENTS) : json({ resources: [] })
      if (url.pathname === "/v2/lm/scenarios/foundation-models/models") return json(CATALOG)
      if (url.pathname === "/v2/lm/configurations/" + CONFIG_ID && !url.search) return json(CONFIGURATIONS[CONFIG_ID])
    }
    unexpected = method + " " + url.href
    throw new Error("unexpected request: " + unexpected)
  }
  try {
    const plugin = await SAPAICorePlugin()

    const config = {}
    await plugin.config(config)
    expect(plugin.auth.provider).toBe("sap-aicore")
    expect(plugin.provider.id).toBe("sap-aicore")
    expect(config.provider["sap-aicore"].npm).toBe("@ai-sdk/openai")
    expect(config.provider["sap-aicore"].models).toEqual({})

    const beforeRefusal = calls
    writeFileSync(join(scratch, "malformed.json"), "{ not valid json")
    const malformed = await plugin.auth.methods[0].authorize({ credentialFile: join(scratch, "malformed.json") })
    expect(malformed.type).toBe("failed")
    const relative = await plugin.auth.methods[0].authorize({ credentialFile: "relative/creds.json" })
    expect(relative.type).toBe("failed")
    expect(calls).toBe(beforeRefusal)

    const credentialFile = join(scratch, "creds.json")
    writeFileSync(credentialFile, JSON.stringify(CREDS), { mode: 0o600 })
    const signedIn = await plugin.auth.methods[0].authorize({ credentialFile })
    expect(signedIn.type).toBe("success")
    const auth = { type: "api", key: signedIn.key, metadata: signedIn.metadata }

    const models = await plugin.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toContain(MODEL)
    expect(models[MODEL].api.npm).toBe("@ai-sdk/openai")

    const opts = await plugin.auth.loader(async () => auth)
    const afterWarm = calls
    const blocked = await opts.fetch("https://malicious.example.com/responses", { method: "POST", body: "{}" })
    expect(blocked.status).toBe(400)
    expect((await blocked.json()).error.code).toBe("destination")
    expect(calls).toBe(afterWarm)

    expect(unexpected).toBeNull()
  } finally {
    globalThis.fetch = realFetch
    rmSync(scratch, { recursive: true, force: true })
  }
})
