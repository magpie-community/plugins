import type { Config, Stats } from "./types.js";
export declare const escapeXml: (s: unknown) => string;
export declare function compact(n: number): string;
export declare function renderCard(s: Stats, c: Config, mode: "light" | "dark", updated: string): string;
export declare function readmeSnippet(c: Config, branch?: string): string;
