// Runs in Magpie's moejs sandbox: no Node/Bun APIs or external imports here.
export const agent = {
  id: 'nowledge-mem',
  name: 'Nowledge Mem / AI Now',
  bin: 'nmem',
  config: '~/.config/magpie-nowledge-mem/selection.json',
  format: 'json',
  model: 'model',
  ua: ['nowledge', 'nmem'],
  notice: '同步 Default、AI Now 和后台任务；打开 Nowledge Mem，等待数秒后开始新对话。卸载前请先断开此 Agent。',
};

export function connect({ gateway, model }) {
  return {
    'gateway.baseURL': gateway.v1,
    'gateway.key': gateway.key,
    'metadata.context': model.context || null,
    'metadata.output': model.output || null,
    'metadata.images': typeof model.images === 'boolean' ? model.images : null,
  };
}
