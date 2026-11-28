const provider = 'magpie-thinkrail'

export const agent = {
  id: 'thinkrail',
  name: 'ThinkRail',
  icon: 'https://thinkrail.ai/favicon.svg',
  dir: '~/.thinkrail',
  config: '~/.pi/agent/models.json',
  startup: {
    config: '~/.thinkrail/config.json',
    model: 'defaultModel.id',
    keys: {
      'defaultModel.provider': provider,
      'defaultModel.name': 'Magpie',
      'defaultModel.thinkingLevels': [],
    },
  },
  library: { mcp: '~/.pi/agent/mcp.json', mcpFormat: 'claude' },
  notice: '更改模型后，重新打开 ThinkRail 并新建聊天。',
}

function catalogEntry(model) {
  const entry = { id: model.id, name: model.name || model.id }
  if (model.context > 0) entry.contextWindow = model.context
  if (model.output > 0) entry.maxTokens = model.output
  if (model.images) entry.input = ['text', 'image']
  if (model.efforts && model.efforts.length) entry.reasoning = true
  return entry
}

export function connect({ gateway, model, models }) {
  const catalog = (models || []).slice()
  if (model && !catalog.some(entry => entry.id === model.id)) catalog.push(model)
  return {
    [`providers.${provider}`]: {
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      api: 'openai-completions',
      models: catalog.map(catalogEntry),
    },
  }
}
