// A local stand-in for a model API, for test/real: answers OpenAI Chat Completions, OpenAI Responses and Anthropic
// Messages (streaming or not) with "I see it", and keeps every request body so a test can look for the image.
// No key is checked and nothing leaves the machine.
import { createServer } from "node:http";

export function startFakeLlm() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = raw; }
      requests.push({ method: req.method, url: req.url ?? "", body });
      const url = req.url ?? "";
      const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const sse = () => res.writeHead(200, { "content-type": "text/event-stream" });
      const model = body?.model ?? "vis";
      if (url.includes("/models")) return json({ object: "list", data: [{ id: "vis", object: "model" }], models: [] });
      if (url.includes("/chat/completions")) {
        if (!body?.stream) return json({ id: "c1", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "I see it" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        sse();
        const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices, ...extra })}\n\n`);
        chunk([{ index: 0, delta: { role: "assistant", content: "I see it" }, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
        chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        return res.end("data: [DONE]\n\n");
      }
      if (url.includes("/messages")) {
        if (url.includes("count_tokens")) return json({ input_tokens: 1 });
        const msg = { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: "I see it" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body?.stream) return json(msg);
        sse();
        const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
        ev("message_start", { message: { ...msg, content: [], stop_reason: null } });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "I see it" } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        ev("message_stop", {});
        return res.end();
      }
      if (url.includes("/responses")) {
        sse();
        const item = { id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "I see it", annotations: [] }] };
        const r = { id: "r1", object: "response", created_at: 1, status: "in_progress", model, output: [], usage: null };
        let seq = 0;
        const ev = (d) => res.write(`event: ${d.type}\ndata: ${JSON.stringify({ ...d, sequence_number: seq++ })}\n\n`);
        ev({ type: "response.created", response: r });
        ev({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        ev({ type: "response.content_part.added", item_id: "m1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        ev({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "I see it" });
        ev({ type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: "I see it" });
        ev({ type: "response.output_item.done", output_index: 0, item });
        ev({ type: "response.completed", response: { ...r, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
        return res.end();
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
