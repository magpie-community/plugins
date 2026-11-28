import { readFileSync } from 'node:fs';
import { createCleanFetch, discoverModels, providerConfig } from './lib/adapter.mjs';

const knownModels = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));

export const CodexFreeApiPlugin = async (_input, options = {}) => ({
  async config(config) {
    config.provider ??= {};
    config.provider['codex-free-api-quota'] ??= providerConfig(knownModels);
  },
  auth: {
    provider: 'codex-free-api-quota',
    methods: [{
      type: 'api',
      label: 'OpenAI 官方 API Key',
      placeholder: 'sk-…（在这里填写官方 API Key）',
      prompts: [
        { type: 'text', required: false, key: 'email', message: '账号名称（可选，便于区分多个 Key）', placeholder: '例如：个人 OpenAI', validate: value => value.length > 100 ? '账号名称最多 100 个字符' : undefined },
        { type: 'text', required: false, key: 'organization', message: 'OpenAI Organization ID（可选，通常留空）', placeholder: 'org-…', validate: value => value && !/^[A-Za-z0-9_-]+$/.test(value) ? '只填写 Organization ID，不要填写网址' : undefined },
        { type: 'text', required: false, key: 'project', message: 'OpenAI Project ID（可选，通常留空）', placeholder: 'proj_…', validate: value => value && !/^[A-Za-z0-9_-]+$/.test(value) ? '只填写 Project ID，不要填写网址' : undefined },
      ],
    }],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== 'api' || !auth.key?.trim()) return {};
      return {
        baseURL: 'https://api.openai.com/v1',
        fetch: createCleanFetch(getAuth, options),
      };
    },
  },
  provider: {
    id: 'codex-free-api-quota',
    async models(provider, { auth } = {}) {
      if (auth?.type !== 'api' || !auth.key?.trim()) return {};
      return discoverModels(provider, auth, knownModels, options);
    },
  },
});
