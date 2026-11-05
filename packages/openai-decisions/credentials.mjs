import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SAVED_OPENAI = "magpie-provider:openai";

function providersFile() {
  const root = process.env.XDG_CONFIG_HOME || (process.platform === "win32"
    ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    : join(homedir(), ".config"));
  return join(root, "magpie", "providers.json");
}

export function readOpenAIKey(path = providersFile()) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Could not read Magpie's saved OpenAI provider");
  }
  const provider = data.providers?.find((row) => row.id === "openai");
  const endpoints = [provider?.chat, provider?.responses].filter(Boolean);
  if (!provider || provider.off || provider.preset !== "openai" || !endpoints.length || endpoints.some((url) => url !== "https://api.openai.com/v1")) {
    throw new Error("An enabled official OpenAI provider with ID openai is required for saved-key sign-in");
  }
  if (typeof provider.key !== "string" || !provider.key.trim() || /[\r\n]/.test(provider.key)) throw new Error("The saved OpenAI provider has no usable primary API key");
  return provider.key;
}

export function keyFromAuth(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) throw new Error("Sign in to OpenAI Decisions first");
  return auth.key === SAVED_OPENAI ? readOpenAIKey() : auth.key;
}
