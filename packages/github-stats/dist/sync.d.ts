import { GitHub } from "./github.js";
import type { Config, Stats, SyncState } from "./types.js";
export declare function localDate(d?: Date): string;
export declare function due(c: Config, s: SyncState, now?: Date): boolean;
export declare const readState: (dir?: string) => Promise<SyncState>;
interface Dependencies {
    config?: Config;
    stats?: () => Promise<Stats>;
    github?: GitHub;
    now?: Date;
}
export declare function sync(dir?: string, onlyDue?: boolean, dependencies?: Dependencies): Promise<{
    result: string;
    changed: number;
    branch?: undefined;
    private?: undefined;
} | {
    result: string | undefined;
    changed: number;
    branch: string;
    private: boolean;
}>;
export {};
