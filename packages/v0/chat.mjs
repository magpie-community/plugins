export const BASE = "https://api.v0.dev/v1";
export const MODELS = {
  "v0-mini": { name: "v0 Mini", tool_call: false },
  "v0-pro": { name: "v0 Pro", tool_call: false },
  "v0-max": { name: "v0 Max", tool_call: false },
  "v0-max-fast": { name: "v0 Max Fast", tool_call: false },
};

function error(status, message) {
  return Response.json({ error: { message } }, { status });
}

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")) {
    return content.map((part) => part.text).join("\n");
  }
  return undefined;
}

export function chatFetch(key, upstream = globalThis.fetch) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${BASE}/chat/completions` || request.method !== "POST") {
      return error(404, "v0 supports Chat Completions only");
    }

    const body = await request.json().catch(() => null);
    if (typeof body?.model !== "string" || !Object.hasOwn(MODELS, body.model) || !Array.isArray(body.messages) || body.n > 1) {
      return error(400, "Choose a v0 model and provide messages for one completion");
    }
    if (body.tool_choice && !["none", "auto"].includes(body.tool_choice)) {
      return error(400, "v0 cannot invoke client tools");
    }

    const transcript = body.messages.map((message) => ({
      role: message?.role,
      content: text(message?.content),
    }));
    if (!transcript.some(({ role, content }) => role === "user" && content?.trim()) ||
        transcript.some(({ role, content }) => !["system", "developer", "user", "assistant"].includes(role) || content === undefined) ||
        body.messages.some((message) => message?.tool_calls?.length || message?.function_call)) {
      return error(400, "v0 requires text messages and cannot replay client tool calls");
    }

    const response = await upstream(`${BASE}/chats`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      redirect: "error",
      signal: init?.signal ?? request.signal,
      body: JSON.stringify({
        privacy: "private",
        modelConfiguration: { modelId: body.model },
        message: transcript.length === 1 ? transcript[0].content : JSON.stringify(transcript),
      }),
    });
    if (!response.ok) {
      const headers = new Headers();
      const retry = response.headers.get("retry-after");
      if (retry) headers.set("retry-after", retry);
      await response.body?.cancel();
      return Response.json({ error: { message: `v0 Platform API returned HTTP ${response.status}` } }, { status: response.status, headers });
    }

    const chat = await response.json().catch(() => null);
    const answer = Array.isArray(chat?.messages) ? chat.messages.findLast((message) => message?.role === "assistant") : null;
    if (!chat?.id || typeof answer?.content !== "string" || !answer.content.trim() || !["stop", "length"].includes(answer.finishReason)) {
      return error(502, "v0 did not return a completed text response");
    }

    const meta = { id: chat.id, created: Math.floor(Date.now() / 1000), model: body.model };
    const finish_reason = answer.finishReason;
    if (!body.stream) {
      return Response.json({
        ...meta, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: answer.content }, finish_reason }],
      });
    }

    const chunk = (delta, finish) => JSON.stringify({
      ...meta, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return new Response(
      `data: ${chunk({ role: "assistant", content: answer.content }, null)}\n\ndata: ${chunk({}, finish_reason)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
}
