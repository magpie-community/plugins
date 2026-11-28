import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// MagPie provider marks, not the maker inferred from a model's name.
const marks = {
  codex: 'codex-color', claude: 'claudecode-color', anthropic: 'anthropic', openai: 'openai',
  'opencode-go': 'opencode', 'opencode-zen': 'opencode', cursor: 'cursor', grok: 'xai', xai: 'xai',
  gemini: 'gemini-color', google: 'google-color', antigravity: 'antigravity-color',
  deepseek: 'deepseek-color', kimi: 'kimi', moonshot: 'moonshot', minimax: 'minimax-color',
  zhipu: 'zhipu-color', zai: 'zai', qwen: 'qwen-color', mistral: 'mistral-color',
};

export const magpieConfig = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie');

export function withModelIcons(models, config = {}) {
  const providers = new Map((Array.isArray(config?.providers) ? config.providers : []).filter(p => typeof p?.id === 'string').map(p => [p.id, p]));
  const groups = new Map((Array.isArray(config?.groups) ? config.groups : []).filter(g => typeof g?.id === 'string').map(g => [g.id, g]));
  const iconsFor = (id, seen = new Set()) => {
    id = id.replace(/^mac\//, '');
    const [provider, ...rest] = id.split('/');
    if (provider === 'group') {
      const group = groups.get(rest.join('/'));
      if (!group || seen.has(group.id)) return [];
      const next = new Set([...seen, group.id]);
      return [...new Set((Array.isArray(group.members) ? group.members : []).filter(m => typeof m === 'string').flatMap(m => iconsFor(m, next)))];
    }
    const p = providers.get(provider);
    const icon = p?.icon || marks[p?.preset] || marks[provider];
    return icon && /^(?:[a-z0-9-]+|file:[a-f0-9]{8,64}\.(?:png|webp|jpe?g|svg))$/i.test(icon) ? [icon] : [];
  };
  return models.map(model => ({ ...model, icons: iconsFor(model.id) }));
}

export async function decorateModels(models) {
  // Only icon IDs and group membership cross the response boundary. Provider
  // settings also contain credentials; never return or log the parsed record.
  let config = {};
  try { config = JSON.parse(await readFile(join(magpieConfig(), 'providers.json'), 'utf8')); } catch { /* The catalog remains usable without optional icon metadata. */ }
  return withModelIcons(models, config);
}
