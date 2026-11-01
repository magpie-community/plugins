import type { Analysis, Challenge, Sample, Api } from '../vendor/lmfpd-sdk/index.js';
export type { Analysis, Challenge, Sample, Api };
export interface Model {
  id: string;
  name: string;
  provider: string;
  efforts: string[];
  nativeEndpoints: string[];
}
export interface Account {
  id: string;
  name: string;
  provider: string;
}
export interface Target {
  model: string;
  /** The account the samples are pinned to: Magpie's own name for it (its user, an email or a login), which routing rests and matches it by. */
  account?: string;
  /** Its name as the page listed it, when the catalog had it. */
  accountName?: string;
}
export interface RunConfig {
  targets: Target[];
  /** The account every target is pinned to, and its name; absent in jobs saved before 0.2.2 and when the targets differ. */
  account?: string;
  accountName?: string;
  api: Api | 'auto';
  effort: string;
  serviceTier: 'default' | 'flex' | 'fast' | 'ultrafast';
  strict: boolean;
  targetParallel: number;
  sampleParallel: number;
  deadlineSeconds: number;
}
export interface Provenance {
  session: string;
  requestedModel: string;
  provider?: string;
  model?: string;
  route?: unknown;
  routeError?: string;
  mismatch?: boolean;
  streamNormalization?: 'chat-done-after-stop';
}
export interface TargetResult {
  id: string;
  target: Target;
  api: Api;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  samples: Sample[];
  provenance: Provenance[];
  analysis: Analysis | null;
  error: string | null;
}
export interface Job {
  id: string;
  createdAt: string;
  finishedAt?: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  config: RunConfig;
  challenges: Challenge[];
  results: TargetResult[];
  bank: { builtAt: string; sdk: string };
  error?: string;
  demo?: boolean;
}
export interface Bootstrap {
  version: string;
  demo: boolean;
  models: Model[];
  accounts: Account[];
  jobs: Job[];
  bank: { builtAt: string; modelCount?: number } | null;
  bankStatus: { state: 'missing' | 'cached' | 'ready' };
  gateway: { url: string; reachable: boolean; error?: string };
  bankError?: string;
}
