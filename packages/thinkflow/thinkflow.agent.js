const providerId = "magpie-thinkflow";

export const agent = {
  id: "thinkflow",
  name: "ThinkFlow",
  bin: "thinkflow",
  config: "~/.thinkflow/config.json",
  model: "model",
  notice: "Restart ThinkFlow to use the connected model.",
};

export function connect({ gateway, model, models }) {
  if (!gateway?.v1 || !gateway?.key || !model?.id) {
    throw new Error("ThinkFlow requires a gateway URL, key, and model ID.");
  }

  const profile = {
    provider: "openai",
    base_url: gateway.v1,
    api_path: "/chat/completions",
    api_key: gateway.key,
    model: model.id,
    models: [...new Set([
      ...(Array.isArray(models) ? models.map((entry) => entry?.id) : []),
      model.id,
    ].filter((id) => typeof id === "string" && id.length > 0))],
  };

  return {
    active_provider: providerId,
    provider: profile.provider,
    base_url: profile.base_url,
    api_path: profile.api_path,
    api_key: profile.api_key,
    model: profile.model,
    models: profile.models,
    [`providers.${providerId}`]: profile,
  };
}
