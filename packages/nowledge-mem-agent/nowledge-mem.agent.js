// Runs in Magpie's moejs sandbox: no Node/Bun APIs or external imports here.
export const agent = {
  id: 'nowledge-mem',
  name: 'Nowledge Mem / AI Now',
  icon: 'https://mem.nowledge.co/favicon.png',
  bin: 'nmem',
  dir: '~/Library/Application Support/co.nowledge.mem.desktop',
  config: '~/.config/magpie-nowledge-mem/selection.json',
  format: 'json',
  model: 'model',
  ua: ['nowledge', 'nmem'],
  notice: 'Syncs Default, AI Now and Background. Keep Nowledge open; start a new chat after a few seconds. Disconnect before uninstalling. 同步 Default、AI Now 和后台任务；保持 Nowledge 运行，等待数秒后开始新对话。卸载前先断开此 Agent。',
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
