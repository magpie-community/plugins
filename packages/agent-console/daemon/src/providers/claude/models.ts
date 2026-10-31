// Model list (§7.2.7): Claude Code has no model query API.
// Behind the magpie gateway, gateway models, the default model and thinking levels are filled in by providers/magpieGateway.ts;
// without magpie only "Default" is offered (the frontend always shows it; no empty-id placeholder is added here anymore).
import type { ModelInfo } from "../types.js";

export async function listClaudeModels(): Promise<ModelInfo[]> {
  return [];
}
