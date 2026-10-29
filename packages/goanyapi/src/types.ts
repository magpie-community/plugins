export const PROVIDER = "goanyapi";
export const API_BASE = "https://api.goanyapi.com";
export const MCP_BASE = "https://mcp.goanyapi.com";
// Identifies Magpie traffic to GoAnyAPI; keep in step with package.json.
export const USER_AGENT = "goanyapi-magpie/0.1.1";

export interface StoredOAuth {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  clientId: string;
  tokenEndpoint: string;
  issuer: string;
}
export interface StoredAPI {
  type: "api";
  key: string;
}
export type StoredAuth = StoredOAuth | StoredAPI;

export interface PluginInput {
  directory: string;
  client: {
    auth: {
      set(input: { path: { id: string }; body: StoredAuth }): Promise<unknown>;
    };
  };
}
export interface Options {
  apiKey?: string;
  baseUrl?: string;
  mcpBaseUrl?: string;
}

export function serviceURL(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "GoAnyAPI endpoints must use HTTPS (HTTP is allowed on loopback for local testing).",
    );
  }
  return url;
}
