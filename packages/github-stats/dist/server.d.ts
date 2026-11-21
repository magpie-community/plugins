import { type IncomingMessage, type ServerResponse } from "node:http";
export declare function startServer({ port, dir, }?: {
    port?: number;
    dir?: string;
}): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    url: string;
    close: () => Promise<void>;
}>;
