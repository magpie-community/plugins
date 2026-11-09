// Mistral Vibe's public endpoints. The API root is overridable so the test
// suite can point the same code at a local server; nothing else uses it.
export const API_ROOT = (process.env.MISTRAL_VIBE_API_ROOT || "https://api.mistral.ai").replace(/\/+$/, "")
export const CONSOLE_ROOT = (process.env.MISTRAL_VIBE_CONSOLE_ROOT || "https://console.mistral.ai").replace(/\/+$/, "")
export const V1 = `${API_ROOT}/v1`

export const PROVIDER_ID = "mistral-vibe"
export const NPM = "@ai-sdk/openai-compatible"

// The Vibe plan grants its own monthly allowance ("Vibe Code budget"), and the
// key it provisions is a plain Mistral API key: every request through it is
// billed to that allowance first. Same key the official CLI writes to
// ~/.vibe/.env; https://chat.mistral.ai/code/extensions shows and rotates it.
export const KEY_HINT = "Vibe API Key (chat.mistral.ai/code/extensions → Vibe CLI → Advanced)"

// Friendly names -> the id Mistral serves them as. Plain facts about the
// ids; the same table mistral-gateway lists.
export const MODEL_ALIASES = {
  "mistral-large": "mistral-large-4",
  "mistral-large-latest": "mistral-large-4",
  "deepseek-v4.1-flash": "deepseek-v4-1-flash-1017",
  "deepseek-v4.1-flash-1017": "deepseek-v4-1-flash-1017",
  "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017",
  "deepseek-v4-flash-1017": "deepseek-v4-1-flash-1017",
  "zai-glm-5.3": "zai-glm-5-3",
  "zai-glm-5.3-flash": "zai-glm-5-3-flash",
  "glm-5.3": "zai-glm-5-3",
  "glm-5.3-flash": "zai-glm-5-3-flash",
  "zai-glm-5.2": "zai-glm-5-2",
  "glm-5.2": "zai-glm-5-2",
}

export const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
