import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Older gateways omit Cursor's fast flag from /v1/models; read only capability metadata. */
export const loadFastModelIDs = async (): Promise<Set<string>> => {
  const path = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'magpie',
    'plugin-providers.json',
  );
  const ids = new Set<string>();
  try {
    const providers = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(providers)) return ids;
    for (const provider of providers) {
      if (typeof provider?.id !== 'string' || !Array.isArray(provider.models)) continue;
      for (const model of provider.models) {
        if (typeof model?.id !== 'string') continue;
        const priority =
          Array.isArray(model.serviceTiers) && model.serviceTiers.includes('priority');
        if (priority || (provider.id === 'cursor' && model.fast === true))
          ids.add(`${provider.id}/${model.id}`);
      }
    }
  } catch {
    // This optional local cache may be absent, being replaced, or from another version.
  }
  return ids;
};
