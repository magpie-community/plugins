export interface HeaderPreset {
  id: string;
  name: string;
  version: string;
  scope: 'agent' | 'openai' | 'openrouter' | 'cline';
  headers: Readonly<Record<string, string>>;
  sources: readonly string[];
}

/** Client identity snapshots, not complete SDK or authentication configurations. */
export const headerPresets: readonly HeaderPreset[] = [
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    version: '0.169.0',
    scope: 'agent',
    headers: {
      'User-Agent': 'codex_cli_rs/0.169.0',
      originator: 'codex_cli_rs',
    },
    sources: [
      'https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/login/src/auth/default_client.rs',
    ],
  },
  {
    id: 'claude-code',
    name: 'Claude Code (headless)',
    version: '2.1.326',
    scope: 'agent',
    headers: {
      'User-Agent': 'claude-cli/2.1.326 (external, sdk-cli)',
      'x-app': 'cli',
    },
    sources: [
      'https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.326',
      'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.326',
      'https://code.claude.com/docs/en/llm-gateway-protocol',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    version: '1.19.6',
    scope: 'openai',
    headers: {
      'User-Agent': 'opencode/1.19.6',
      originator: 'opencode',
    },
    sources: [
      'https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/plugin/openai/codex.ts',
      'https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/llm/request.ts',
    ],
  },
  {
    id: 'cline',
    name: 'Cline',
    version: '4.1.26',
    scope: 'cline',
    headers: {
      'User-Agent': 'Cline/4.1.26',
      'HTTP-Referer': 'https://cline.bot',
      'X-Title': 'Cline',
    },
    sources: [
      'https://github.com/cline/cline/blob/4cdfb19a5e897b9e75827cbb4f280f322e27e44a/sdk/packages/llms/src/providers/request-headers.ts',
      'https://github.com/cline/cline/blob/4cdfb19a5e897b9e75827cbb4f280f322e27e44a/apps/vscode/src/sdk/cline-session-factory.ts',
    ],
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    version: '3.53.0',
    scope: 'openrouter',
    headers: {
      'User-Agent': 'RooCode/3.53.0',
      'HTTP-Referer': 'https://github.com/RooVetGit/Roo-Cline',
      'X-Title': 'Roo Code',
    },
    sources: [
      'https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/api/providers/constants.ts',
      'https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/api/providers/openrouter.ts',
    ],
  },
];

export function presetHeaderText(preset: HeaderPreset): string {
  return Object.entries(preset.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}
