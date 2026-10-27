import { serviceURL } from "./types.ts";

export class AuthenticationError extends Error {}

// Only the six reviewed endpoints are exposed. Match the original client's
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
    const ErrorType = response.status === 401 ? AuthenticationError : Error;
    throw new ErrorType(`Search1API ${name} request failed (${response.status}).`);
  }
  try {
    return await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === "TimeoutError") throw error;
    throw new Error(`Search1API returned invalid JSON for ${name}.`);
  }
}
