import type { Config } from "./types.js";
export declare class GitHubError extends Error {
    status: number;
    retryAt?: string | undefined;
    constructor(status: number, retryAt?: string | undefined);
}
export declare class GitHub {
    private token;
    private fetcher;
    private sleep;
    constructor(token: string, fetcher?: typeof fetch, sleep?: (ms: number) => Promise<void>);
    request(path: string, method?: string, body?: unknown, allow404?: boolean): Promise<any>;
    repository(c: Config): Promise<{
        branch: string;
        private: boolean;
    }>;
    put(c: Config, branch: string, name: string, svg: string): Promise<boolean>;
}
