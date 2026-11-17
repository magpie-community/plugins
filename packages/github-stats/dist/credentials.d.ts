import type { Config } from "./types.js";
export declare function resolveToken(config: Config, dir?: string): Promise<string>;
export declare function validateToken(token: unknown): string;
export declare function setToken(token: string, dir?: string): Promise<void>;
export declare function getToken(dir?: string, allowEnv?: boolean): Promise<string>;
