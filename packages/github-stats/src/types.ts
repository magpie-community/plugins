export type Period = "7d" | "30d" | "all";
export type Theme = "aurora" | "minimal" | "cyberpunk";
export interface Config {
  repository: string;
  branch: string;
  folder: string;
  period: Period;
  theme: Theme;
  heatmapView: "month" | "week";
  width: number;
  topModels: number;
  showCost: boolean;
  showTrend: boolean;
  showHeatmap: boolean;
  showModels: boolean;
  daily: boolean;
  magpiePort: number;
  credentialSource: "keychain" | "github-cli";
}
export interface Day {
  date: string;
  requests: number;
  tokens: number;
}
export interface Model {
  name: string;
  requests: number;
  tokens: number;
}
export interface Stats {
  period: Period;
  since: string;
  requests: number;
  tokens: number;
  activeDays: number;
  estimatedCost: number;
  unpriced: number;
  days: Day[];
  heatmap?: { asOf: string; days: Day[] };
  models: Model[];
}
export interface SyncState {
  lastSuccess?: string;
  lastAttempt?: string;
  lastResult?: string;
  error?: string;
  fingerprint?: string;
  publishedDigest?: string;
  publishedDate?: string;
  nextRetry?: string;
}
