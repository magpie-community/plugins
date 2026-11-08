export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new ApiError("invalid");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1048576) {
      await response.body.cancel();
      throw new ApiError("invalid");
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError("invalid"); }
}

export class Hindsight {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async request(path, payload, { signal, timeoutMs }) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let response;
    try {
      response = await this.fetcher(`${this.config.hindsight_api}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "magpie-hindsight/0.1.0" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: combined
      });
    } catch { throw new ApiError("unavailable"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError([401, 403].includes(response.status) ? "unauthorized" : response.status >= 500 || response.status === 429 ? "unavailable" : "invalid");
    }
    return readJson(response);
  }

  async recall(query, signal) {
    const path = `/v1/default/banks/${encodeURIComponent(this.config.bank)}/memories/recall`;
    const data = await this.request(path, {
      query,
      max_tokens: this.config.recall_max_tokens,
      budget: "low",
      include: { entities: null, chunks: null, source_facts: null }
    }, { signal, timeoutMs: Math.max(100, Math.min(8000, this.config.gatewayTimeoutMs - 200)) });
    if (!Array.isArray(data.results)) throw new ApiError("invalid");
    return data.results.flatMap(result => typeof result?.text === "string" && result.text.trim() ? [result.text] : []);
  }

  async retain(query, answer, documentId, agent, protocol, signal) {
    const path = `/v1/default/banks/${encodeURIComponent(this.config.bank)}/memories`;
    return this.request(path, {
      items: [{
        content: `User:\n${query}\n\nAssistant:\n${answer}`,
        context: "Magpie gateway conversation turn",
        document_id: documentId,
        metadata: {
          source: "magpie-hindsight",
          agent: String(agent || "unknown").slice(0, 80),
          protocol: String(protocol || "unknown").slice(0, 32)
        }
      }],
      async: true
    }, { signal, timeoutMs: 10000 });
  }
}
