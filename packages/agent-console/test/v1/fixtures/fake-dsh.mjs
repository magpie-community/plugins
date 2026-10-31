// Behaves like `dsh --profile acp` (0.2.1-rc.5) where images are concerned, for tests. Calls no model.
// - The route it starts on is its `acp` row: deepseek-official / deepseek-v4-flash, or the provider/model of a `--patch` file.
// - initialize advertises promptCapabilities.image only when that route sees images (FAKE_DSH_VISION: comma list of provider/model).
// - session/new reports the model option as dsh does: values are JSON [provider, model].
// - A prompt with an image block on a connection that didn't advertise images is refused with dsh's error.
//   FAKE_ACP_LOG  file each received {argv, prompt} is appended to, one JSON line per prompt
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
let route = ["deepseek-official", "deepseek-v4-flash"];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--patch") continue;
  const y = readFileSync(argv[i + 1], "utf8");
  const provider = /^\s+provider: (.+)$/m.exec(y)?.[1];
  const model = /^\s+model: (.+)$/m.exec(y)?.[1];
  if (/^- id: acp$/m.test(y) && provider && model) route = [JSON.parse(provider), JSON.parse(model)];
}
const vision = new Set((process.env.FAKE_DSH_VISION ?? "").split(",").filter(Boolean));
const image = vision.has(route.join("/"));
const models = [["deepseek-official", "deepseek-flash"], ["magpie", "vis"], ["magpie", "txt"]];
let current = route;
const logFile = process.env.FAKE_ACP_LOG;
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const answer = (id, result) => out({ id, result });
const configOptions = () => [{
  id: "model", category: "model", type: "select", name: "Model", currentValue: JSON.stringify(current),
  options: models.map(([p, m]) => ({ value: JSON.stringify([p, m]), name: m })),
}];

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m.method) return;
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return answer(m.id, {
        protocolVersion: 1,
        agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
        agentCapabilities: { loadSession: false, promptCapabilities: { image, audio: false, embeddedContext: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
        authMethods: [],
      });
    case "session/new":
      return answer(m.id, { sessionId: "fake-dsh-1", configOptions: configOptions() });
    case "session/resume":
      return answer(m.id, { configOptions: configOptions() });
    case "session/load":
      return out({ id: m.id, error: { code: -32601, message: '"Method not found": session/load' } });
    case "session/set_config_option":
      if (p.configId === "model") current = JSON.parse(p.value);
      return answer(m.id, { configOptions: configOptions() });
    case "session/prompt": {
      if (logFile) appendFileSync(logFile, JSON.stringify({ argv, prompt: p.prompt }) + "\n");
      if (!image && p.prompt.some((b) => b.type === "image")) {
        return out({ id: m.id, error: { code: -32602, message: "Invalid params: inline image prompts were not advertised by this connection" } });
      }
      out({ method: "session/update", params: { sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      return answer(m.id, { stopReason: "end_turn" });
    }
    case "session/cancel":
      return;
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
