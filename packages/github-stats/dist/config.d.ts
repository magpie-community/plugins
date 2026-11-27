import type { Config } from "./types.js";
export declare const defaults: Config;
export declare function dataDir(): string;
export declare function jsonFile<T>(file: string, fallback: T): Promise<T>;
export declare function atomicWrite(file: string, value: string): Promise<void>;
export declare function validateConfig(raw: unknown): Config;
export declare function readConfig(dir?: string): Promise<Config>;
export declare function saveConfig(raw: unknown, dir?: string): Promise<Config>;
export declare function withLock<T>(dir: string, work: () => Promise<T>): Promise<T>;
