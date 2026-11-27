import type { Config, Stats } from "./types.js";
export declare function normalizeUsage(raw: unknown, period: Config["period"]): Stats;
export declare function readUsage(config: Config, fetcher?: typeof fetch, now?: Date): Promise<Stats>;
