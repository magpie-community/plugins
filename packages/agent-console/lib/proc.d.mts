export type ProcessAliveDeps = {
  kill?: (pid: number, signal: 0) => unknown;
  platform?: NodeJS.Platform;
  procRoot?: string;
  readFile?: (file: string) => string;
};

export declare function processAlive(pid: number, deps?: ProcessAliveDeps): boolean;
