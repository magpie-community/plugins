// Qianwen (千问 App, com.alibaba.tongyi) as a magpie / OpenCode provider.
// Reads the desktop sign-in saved by Qianwen.app, reproduces the Baxia
// request signing in pure code and calls the web API over plain HTTP:
// no browser, no DOM. Exposed to agents as OpenAI Chat Completions.
import { QianwenSession } from "./session.mjs";

const PROVIDER = "qianwen";
const API = "https://chat2.qianwen.com";

function readAuth(auth) {
  if (auth?.type !== "api") {
    const e = new Error("请先导入千问桌面登录账号（magpie plugin login qianwen）。");
    e.status = 401;
    e.signIn = "required";
    throw e;
  }
  try {
    return JSON.parse(auth.key);
  } catch {
    return {};
  }
}

async function server(_input, options = {}) {
  const sessions = new Map();
  const opts = options && typeof options === "object" ? options : {};
  const sessionFor = (auth) => {
    const binding = readAuth(auth);
    const key = `${binding.profile || "Default"}`;
    if (!sessions.has(key)) sessions.set(key, new QianwenSession(binding, {}));
    return sessions.get(key);
  };

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "千问",
        npm: "@ai-sdk/openai-compatible",
        api: `${API}/v1`,
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "导入千问桌面登录",
          prompts: [],
          async authorize() {
            const session = new QianwenSession({}, {});
            await session.ready();
            const binding = { version: 1, profile: "Default" };
            sessions.set(binding.profile, session);
            const uid = session.uid || "";
            return {
              type: "success",
              key: JSON.stringify(binding),
              metadata: {
                email: `千问桌面账号${uid ? " · " + uid.slice(0, 10) : ""}`,
                uid,
                profile: "Default",
              },
            };
          },
        },
      ],
      async loader(getAuth) {
        return {
          baseURL: `${API}/v1`,
          apiKey: "qianwen-local-session",
          async fetch(input, init) {
            return handleFetch(await getAuth(), input, init);
          },
        };
      },
      async usage() {
        // The Qianwen web app has no stable quota endpoint; empty windows
        // keep usage pages from erroring.
        return { windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const list = await sessionFor(auth).models();
        const out = {};
        for (const m of list) {
          out[m.id] = { id: m.id, name: m.name || m.id };
        }
        return out;
      },
    },
  };

  async function handleFetch(auth, input, init) {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return json({ error: { message: "qianwen: unsupported endpoint" } }, 400);
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: { message: "invalid json" } }, 400);
    }
    const session = sessionFor(auth);
    try {
      // Pass the whole messages array so multi-turn context survives
      // (the session reuses session_id / topic_id and parent_req_id).
      const msgs = (Array.isArray(body.messages) ? body.messages : []).map((m) => {
        const c = m?.content;
        const content =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((p) => p?.text || "").join("\n")
              : "";
        return { role: m?.role || "user", content };
      });
      let text = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i].content) {
          text = msgs[i].content;
          break;
        }
      }
      if (!text) return json({ error: { message: "no user message" } }, 400);
      const model = body.model || "Qwen";
      // Risk control is per cookie/IP; retrying only makes it worse. Do one
      // short backoff, then report the error honestly.
      let reply;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          reply = await session.sendMessage(text, { messages: msgs, model });
          break;
        } catch (e) {
          if (e.rateLimited && attempt === 0) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw e;
        }
      }
      const id = `chatcmpl-${randomId()}`;
      if (!body.stream) {
        return json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
        });
      }
      // The web API returns the whole answer at once; emit it in one chunk
      // followed by [DONE].
      const encoder = new TextEncoder();
      const chunks = [];
      const meta = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
      };
      chunks.push(
        encoder.encode(
          `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`,
        ),
      );
      chunks.push(
        encoder.encode(
          `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { content: reply } }] })}\n\n`,
        ),
      );
      chunks.push(
        encoder.encode(
          `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        ),
      );
      chunks.push(encoder.encode("data: [DONE]\n\n"));
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      const status = error.status || 502;
      return json({ error: { message: error.message || String(error) } }, status);
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export default { id: PROVIDER, server };
