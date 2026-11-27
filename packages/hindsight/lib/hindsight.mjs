export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function readJson(response, maxBytes = 1048576) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new ApiError("invalid");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ApiError("invalid");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError("invalid"); }
}

export function recallTimeout(gatewayTimeoutMs) {
  return Math.max(0, Math.min(8000, gatewayTimeoutMs - 200));
}

export function statusCode(status) {
  if ([401, 403].includes(status)) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return status >= 500 ? "unavailable" : "invalid";
}

export class Hindsight {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  bankPath(suffix) {
    return "/v1/default/banks/" + encodeURIComponent(this.config.bank) + suffix;
  }

  async request(path, payload, { signal, timeoutMs = 3000 } = {}) {
    if (timeoutMs <= 0) throw new ApiError("budget");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const method = payload === undefined ? "GET" : "POST";
    try {
      const response = await this.fetcher(this.config.hindsight_api + path, {
        method,
        headers: method === "GET" ? { Accept: "application/json" } : { "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "error",
        signal: combined
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ApiError(statusCode(response.status));
      }
      return await readJson(response);
    } catch (error) {
      if (signal?.aborted) throw new ApiError("cancelled");
      if (deadline.aborted) throw new ApiError("timeout");
      if (error instanceof ApiError) throw error;
      throw new ApiError("unavailable");
    }
  }

  async recall(query) {
    const tags = this.config.recall_tags;
    const data = await this.request(this.bankPath("/memories/recall"), {
      query,
      max_tokens: this.config.recall_max_tokens,
      budget: "low",
      include: { entities: null, chunks: null, source_facts: null },
      ...(tags.length ? { tags, tags_match: "any_strict" } : {})
    }, { timeoutMs: recallTimeout(this.config.gatewayTimeoutMs) });
    if (!Array.isArray(data?.results)) throw new ApiError("invalid");
    return data.results.flatMap(result => typeof result?.text === "string" && result.text.trim() ? [result.text] : []);
  }

  async retain({ query, answer, documentId, operationId, agent, protocol }, signal) {
    const tags = this.config.recall_tags;
    return this.request(this.bankPath("/memories"), {
      items: [{
        content: "User:\n" + query + "\n\nAssistant:\n" + answer,
        context: "Magpie gateway conversation turn. Assistant replies may contain proposals or unverified claims.",
        document_id: documentId,
        metadata: {
          source: "magpie-hindsight",
          agent: String(agent || "unknown").slice(0, 80),
          protocol: String(protocol || "unknown").slice(0, 32)
        },
        ...(tags.length ? { tags } : {})
      }],
      async: true,
      operation_id: operationId
    }, { signal, timeoutMs: Math.max(100, this.config.gatewayTimeoutMs - 200) });
  }

  operation(id, signal) {
    return this.request(this.bankPath("/operations/" + encodeURIComponent(id)), undefined, { signal });
  }
}
