// Runs in Magpie's moejs sandbox: no Node/Bun APIs or external imports here.
export const agent = {
  id: 'genericagent',
  name: 'GenericAgent',
  config: '~/.genericagent.json',
  format: 'json',
  model: 'model',
  ua: ['genericagent'],
  notice: 'GenericAgent will use the selected model from Magpie. Restart GenericAgent to apply changes. GenericAgent 会使用 Magpie 中选定的模型。重启 GenericAgent 应用更改。',
};

export function connect({ gateway, model }) {
  // Build a GenericAgent-compatible model configuration
  // from the Magpie gateway and model selections.
  return {
    name: model.name || model.id || 'GenericAgent Model',
    apikey: gateway.key,
    apibase: gateway.v1,
    api_mode: 'chat_completions',
    model: model.id,
    max_tokens: model.output || 131072,
    temperature: 1.0,
    max_retries: 3,
    connect_timeout: 10,
    read_timeout: 180,
    context_win: model.context || 1000000,
  };
}
