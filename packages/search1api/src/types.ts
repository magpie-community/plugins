export const PROVIDER = "search1api";
export const API_BASE = "https://api.search1api.com";

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
      "Search1API endpoints must use HTTPS (HTTP is allowed on loopback for local testing).",
    );
  }
  return url;
}
