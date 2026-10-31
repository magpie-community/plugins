import type { Server } from "node:http";
export function failureHtml(error: unknown): string;
export function createGate(options: {
  port: number;
  key: string;
  token: string;
  ensureDaemon: () => Promise<{ port: number }>;
  host?: string;
}): { listen(): Promise<Server>; close(): Promise<void> };
