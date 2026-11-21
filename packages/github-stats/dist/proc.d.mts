export function processZombie(pid: any, { procRoot, readFile, }?: {
    procRoot?: string | undefined;
    readFile?: ((file: any) => string) | undefined;
}): boolean;
export function processAlive(pid: any, deps?: {}): boolean;
export function processExists(pid: any, deps?: {}): boolean;
export function processStatus(pid: any, deps?: {}): {
    state: string;
    error?: undefined;
} | {
    state: string;
    error: unknown;
};
export function processProbe(pid: any, deps?: {}): string;
