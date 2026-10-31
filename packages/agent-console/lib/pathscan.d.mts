export type ScanOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  extra?: boolean;
  exists?: (file: string) => boolean;
};
export function extraBinDirs(opts?: ScanOptions): string[];
export function searchDirs(opts?: ScanOptions): string[];
export function findOnPath(name: string, opts?: ScanOptions): string[];
export function findNode(opts?: ScanOptions): string | null;
export function isNodeExecutable(file: string): boolean;
export declare const NODE_MISSING_MESSAGE: string;
export declare const NODE_TOO_OLD_MESSAGE: string;
export declare function requireNode(opts?: { execPath?: string; find?: () => string | null }): string;
