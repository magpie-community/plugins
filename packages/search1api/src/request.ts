import { serviceURL, USER_AGENT } from "./types.ts";

// The status lets magpie's web search rest a refused account (401, 402, 429)
// and try the next search API; the message never carries the response body.
export class APIError extends Error {
  status: number;
  retryAfter?: string;
  constructor(message: string, status: number, retryAfter?: string) {
    super(message);
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}
export class AuthenticationError extends APIError {}

// Only the reviewed endpoints (six tools, web search and feedback) are exposed. Match the original client's
// request bodies and deadlines without adding runtime npm dependencies.
export async function request(
  baseUrl: string,
  name: string,
  token: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(serviceURL(`${baseUrl}/${name}`), {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(name === "ask" ? 45_000 : 30_000),
    ]),
  });
  if (!response.ok) {
    // Error bodies can echo credentials. Expose only the endpoint and status.
    await response.body?.cancel();
    const ErrorType = response.status === 401 ? AuthenticationError : APIError;
    throw new ErrorType(
      `Search1API ${name} request failed (${response.status}).`,
      response.status,
      response.headers.get("retry-after") ?? undefined,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === "TimeoutError") throw error;
    throw new Error(`Search1API returned invalid JSON for ${name}.`);
  }
}
