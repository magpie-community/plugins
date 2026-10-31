// Nowledge Mem (mem.nowledge.co) for every agent behind magpie, as a gateway
// request hook: before a request goes to its model, the user's turn is given
// what Mem recalls for it, and a session's first turn also gets Mem's Context
// Bundle (owner profile, rules and Working Memory). The completed conversation
// is imported as a Mem Thread, which Mem distills into Memory on its own.
//
// Every harness Magpie routes gets this without its own Mem plugin: recall,
// the session's Context Bundle (or Working Memory when the bundle is missing),
// and completed-conversation capture all happen at the gateway. Mem's own MCP
// server supplies agent-callable tools through Magpie's Library.
//
//   {"serverUrl": "http://127.0.0.1:14242", "apiKey": "nmem_…", "apiKeyEnv": "NMEM_API_KEY",
//    "spaceId": "", "agentId": "", "hostAgentId": "", "recall": true,
//    "contextBundle": true, "maxMemories": 5, "maxBytes": 6000,
//    "requestTimeoutMs": 900, "recallBackoffMs": 30000, "capture": false,
//    "captureTools": true, "captureFilter": "off", "captureCindy": false,
//    "allowInsecureHttp": false}
//
// A turn keeps the block it was given for the rest of the conversation, so what
// the agent sends stays the same from one request to the next and the
// provider's prompt cache keeps working. Anything that goes wrong leaves the
// request as it came.
import { resolve } from "node:path";
import { captureMessage } from "./capture-filter.mjs";
import { conversation as transcript, history, notice, open, close } from "./conversation.mjs";
import { MemFailure as Failure, resolveOptions, request, serviceKey, sha256, trimText, utf8, version } from "./mem.mjs";
const maxQuery = 2000;
const maxMemory = 1000;
const maxImport = 512 << 10;
const writeTimeoutMs = 10_000;
const recallCacheBytes = 8 << 20;
const maxSessions = 256;
const maxTurns = 128;
// Mem's own DeepSeek Harness integration puts its bundle in the prompt. An
// agent that already has Mem context is left alone rather than given a second
// copy of the same Memory.
const foreign = ["<nowledge_context_bundle>"];
// A prompt that looks like it holds a credential is not saved at all: masking
// part of it could still leave the rest on the server.
const secret = /(?:(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|token|authorization|[A-Za-z0-9]*(?:password|passwd|pwd)|secret|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@|\b(?:sk|rk)_live_[A-Za-z0-9]{8,}|\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [^-]*PRIVATE KEY-----)/iu;
// Failure and its outcome codes live in mem.mjs, so the hook and the tools
// share one connection contract.
// magpie's Bun host is long-lived: these last till the plugin is reloaded.
const sticky = new Map();
const unavailable = new Map();
const bundleUnavailable = new Map();
const sent = new Map();
const titles = new Map();
export function reset() {
    sticky.clear();
    unavailable.clear();
    bundleUnavailable.clear();
    sent.clear();
    titles.clear();
}
export async function onRequest(body, ctx) {
    ctx.state ??= {};
    try {
        return await run(body, ctx);
    }
    catch (error) {
        ctx.report?.(error instanceof Failure ? error.code : "invalid");
        throw error;
    }
}
async function run(body, ctx) {
    const o = resolveOptions(ctx.options);
    const own = ctx.origin === "local" || ctx.origin === "magpie-key";
    const recall = o.recall && own;
    const capture = o.capture && own;
    if (!recall && !capture) {
        ctx.report?.("skipped");
        return;
    }
    // Capture is bound before recall changes the request, so the message
    // history saved is the client's own, without an injected block.
    if (capture && ctx.state)
        ctx.state.nowledgeMem = bind(body, ctx, o);
    if (!recall) {
        ctx.report?.("skipped");
        return;
    }
    const key = serviceKey(o);
    if ((unavailable.get(key) ?? 0) > Date.now()) {
        ctx.report?.("unavailable");
        return;
    }
    const all = turns(body, ctx.protocol);
    const turn = target(all, ctx.query ?? "");
    if (!turn) {
        ctx.report?.("skipped");
        return;
    }
    if (turn.text.includes(open) || hasForeignContext(body, ctx.protocol)) {
        ctx.report?.("skipped");
        return;
    }
    const hostAgentId = hostAgentOf(o, ctx);
    const conversation = lru(sticky, sha256(key, o.agentId ?? "", hostAgentId, ctx.origin ?? "unknown", ctx.protocol, ctx.session ?? "", ctx.cwd ?? ""), () => new Map(), maxSessions);
    const turnKey = (t) => sha256(String(t.index), t.text);
    // earlier turns get back the block each was sent with
    let changed = false;
    for (const t of all) {
        const b = t.role === "user" && t !== turn && !t.text.includes(open) ? conversation.get(turnKey(t)) : undefined;
        if (b?.text) {
            t.append(b.text);
            changed = true;
        }
    }
    const kept = conversation.get(turnKey(turn));
    if (kept) {
        // another request of the same turn (a tool loop): nothing new to recall
        if (kept.text)
            turn.append(kept.text);
        ctx.report?.(kept.bytes ? "ready" : "empty", kept.bytes);
        return kept.text || changed ? body : undefined;
    }
    const query = (ctx.query ?? "").trim() || turn.text.trim();
    if (!query) {
        ctx.report?.("skipped");
        return changed ? body : undefined;
    }
    const send = client(o);
    const first = !all.some((t) => t.role === "assistant");
    const [found, contextInfo] = await Promise.all([
        search(send, o, query, ctx.signal),
        first && o.contextBundle ? context(send, o, ctx.signal, hostAgentId) : null,
    ]);
    ctx.signal.throwIfAborted();
    const b = block(contextInfo, found, o.maxBytes);
    lru(conversation, turnKey(turn), () => b, maxTurns);
    // Count the full escaped block, not just the service's content.
    conversation.bytes = [...conversation].reduce((n, [, v]) => n + utf8(v.text), 0);
    trimCache(sticky, recallCacheBytes);
    ctx.report?.(b.bytes ? "ready" : "empty", b.bytes);
    if (!b.text)
        return changed ? body : undefined;
    turn.append(b.text);
    return body;
}
// --- the agent's request, in each API's own shape ---
// turns is each user and assistant message with text, and a way to add
// text to a user's; tool calls, images, reasoning and system prompts are
// left as they are.
function turns(body, protocol) {
    if (protocol === "responses" && typeof body.input === "string") {
        return [{ index: 0, role: "user", text: body.input, append: (t) => { body.input += t; } }];
    }
    const list = protocol === "gemini" ? body.contents : protocol === "responses" ? body.input : body.messages;
    if (!Array.isArray(list))
        return [];
    const out = [];
    list.forEach((msg, index) => {
        if (!msg || typeof msg !== "object")
            return;
        if (protocol === "responses" && msg.type !== undefined && msg.type !== "message")
            return;
        const role = msg.role === "user" ? "user" : msg.role === "assistant" || (protocol === "gemini" && msg.role === "model") ? "assistant" : undefined;
        if (!role)
            return;
        const key = protocol === "gemini" ? "parts" : "content";
        if (typeof msg[key] === "string") {
            out.push({ index, role, text: msg[key], append: (t) => { msg[key] += t; } });
            return;
        }
        if (!Array.isArray(msg[key]))
            return;
        const parts = msg[key].filter((p) => p && typeof p.text === "string" && (protocol === "gemini" ? p.thought !== true
            : role === "assistant" ? p.type === "text" || p.type === "output_text" : p.type === "text" || p.type === "input_text"));
        if (!parts.length)
            return;
        out.push({
            index, role,
            text: parts.map((p) => p.text).join("\n"),
            append: (t) => msg[key].push(protocol === "gemini" ? { text: t } : { type: protocol === "responses" ? "input_text" : "text", text: t }),
        });
    });
    return out;
}
// target is the user turn the request is about: the one with magpie's
// reading of what the user said, else the last one with text.
function target(all, query) {
    const users = all.filter((t) => t.role === "user");
    const q = query.trim();
    for (let i = users.length - 1; i >= 0; i--)
        if (q && users[i].text.includes(q))
            return users[i];
    return users.at(-1);
}
// hasForeignContext is Mem's own prompt context from another connector; this
// plugin does not add a second copy of the same Memory to that request.
function hasForeignContext(body, protocol) {
    let system;
    if (protocol === "chat")
        system = Array.isArray(body.messages) ? body.messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).join("\n") : "";
    else if (protocol === "responses")
        system = textOf(body.instructions);
    else if (protocol === "anthropic")
        system = textOf(body.system);
    else
        system = textOf(body.systemInstruction);
    return typeof system === "string" && foreign.some((marker) => system.includes(marker));
}
function textOf(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value.map((p) => typeof p === "string" ? p : p?.text).filter((t) => typeof t === "string").join("\n");
    if (value && typeof value === "object" && Array.isArray(value.parts))
        return value.parts.map((p) => p?.text).filter((t) => typeof t === "string").join("\n");
    return "";
}
function block(context, memories, budget) {
    const parts = [];
    let used = 0;
    if (context?.text) {
        // Context orients the session; recalled Memory answers this turn.
        const text = trimText(context.text, Math.min(budget - 128, Math.max(600, Math.floor(budget * 0.45))));
        if (text) {
            parts.push(`## ${context.title}\n${escape(text)}`);
            used += utf8(text);
        }
    }
    if (memories.length) {
        const lines = [];
        for (const memory of memories) {
            const title = escape(trimText(memory.title, 160));
            const content = escape(trimText(memory.content, maxMemory));
            const score = memory.score === undefined ? "" : ` · relevance ${memory.score.toFixed(2)}`;
            const line = `### ${title}\n${content}\nnowledgemem://memory/${memory.id}${score}`;
            if (used + utf8(line) > budget && lines.length)
                break;
            const fitted = used + utf8(line) > budget ? trimText(line, Math.max(256, budget - used)) : line;
            lines.push(fitted);
            used += utf8(fitted);
        }
        if (lines.length)
            parts.push(`## Recalled memories\n${lines.join("\n\n")}`);
    }
    if (!parts.length)
        return { text: "", bytes: 0 };
    return {
        text: `\n\n${open}\n${notice}\n\n${parts.join("\n\n")}\n${close}`,
        bytes: used,
    };
}
// escaped text can't close the block it is in
function escape(text) {
    const tag = open.slice(1, -1);
    return text.replace(new RegExp(`<(/?)${tag}`, "gi"), (_, slash) => `&lt;${slash}${tag}`);
}
// --- the Nowledge Mem service ---
// client sends to the configured server only, with the hook's short recall
// deadline and its longer write deadline. A missing route is an outage for
// recall and a bad request for a write; an unavailable recall backs off.
function client(o) {
    return async (method, route, payload, signal, expected = []) => {
        const recallRoute = route === "memories/search";
        const bundleRoute = route.startsWith("context/bundle");
        const timeoutMs = recallRoute || bundleRoute ? o.requestTimeoutMs : writeTimeoutMs;
        try {
            return await request(o, { method, route, payload, signal, timeoutMs, expected });
        }
        catch (error) {
            const failure = error instanceof Failure && error.code === "notfound"
                ? new Failure(recallRoute ? "unavailable" : "invalid", error.status)
                : error;
            if (failure instanceof Failure && failure.code === "unavailable" && recallRoute) {
                const key = serviceKey(o);
                unavailable.delete(key);
                lru(unavailable, key, () => Date.now() + o.recallBackoffMs, maxSessions);
            }
            throw failure;
        }
    };
}
async function search(send, o, query, signal) {
    const payload = { query: Array.from(query).slice(0, maxQuery).join(""), limit: o.maxMemories };
    if (o.spaceId)
        payload.space_id = o.spaceId;
    return memories((await send("POST", "memories/search", payload, signal)).body, o.maxMemories);
}
// context is Mem's Context Bundle, rendered by the server for agents: owner
// profile, rules and Working Memory. It is optional; a server without the
// endpoint or a bundle with nothing in it simply starts the session without.
async function context(send, o, signal, hostAgentId) {
    const key = serviceKey(o);
    if ((bundleUnavailable.get(key) ?? 0) <= Date.now()) {
        const query = new URLSearchParams({ source_app: "magpie", include_working_memory: "true" });
        if (o.agentId)
            query.set("agent_id", o.agentId);
        if (hostAgentId)
            query.set("host_agent_id", hostAgentId);
        if (o.spaceId)
            query.set("space_id", o.spaceId);
        try {
            const r = await send("GET", `context/bundle?${query}`, undefined, signal, [404]);
            const markdown = r.body?.rendered_markdown;
            if (r.status !== 404 && typeof markdown === "string" && markdown.trim())
                return { title: "Context bundle", text: markdown };
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            // An optional bundle failing must not disable healthy Memory recall.
            if (error instanceof Failure && error.code === "unavailable") {
                bundleUnavailable.delete(key);
                lru(bundleUnavailable, key, () => Date.now() + o.recallBackoffMs, maxSessions);
            }
        }
    }
    // Working Memory is the lightweight fallback when the bundle is missing,
    // empty or failing; Mem's own clients use it the same way.
    return workingMemory(send, o, signal);
}
async function workingMemory(send, o, signal) {
    const query = new URLSearchParams();
    if (o.spaceId)
        query.set("space_id", o.spaceId);
    try {
        const r = await send("GET", `agent/working-memory${query.size ? `?${query}` : ""}`, undefined, signal);
        const content = r.body?.content;
        return typeof content === "string" && content.trim() ? { title: "Working Memory", text: content } : null;
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        return null;
    }
}
// hostAgentOf is the gateway's provenance for the harness behind a request:
// one Magpie install serves several agents, and Mem can keep a derived AI
// identity for each. An explicit hostAgentId wins.
function hostAgentOf(o, ctx) {
    if (o.hostAgentId)
        return o.hostAgentId;
    return ctx.agent ? `magpie:${ctx.agent}` : "magpie";
}
// memories is a Mem search answer: each hit names a Memory with its text and,
// when it has one, a relevance score.
function memories(value, limit) {
    if (!Array.isArray(value))
        throw new Failure("invalid");
    const out = [];
    for (const item of value.slice(0, limit)) {
        const memory = item?.memory;
        if (!memory || typeof memory !== "object" || typeof memory.id !== "string" || !memory.id || typeof memory.content !== "string")
            continue;
        if (!memory.content.trim())
            continue;
        const title = typeof memory.title === "string" && memory.title.trim() ? memory.title.trim() : "Memory";
        const score = typeof item.similarity_score === "number" && Number.isFinite(item.similarity_score) ? item.similarity_score : undefined;
        out.push({ id: memory.id, title, content: memory.content, score });
    }
    return out;
}
// --- capture ---
// bind runs before recall, so the captured history is what the client sent.
function bind(body, ctx, o) {
    const messages = history(body, ctx.protocol);
    const users = messages.filter((m) => m.role === "user");
    // The first user message names a session-less conversation: it is the same
    // on every turn, while the query is not.
    const first = users[0]?.content ?? "";
    // A session names its Thread; a client without one (curl, an SDK) gets a
    // Thread per conversation, identified by its opening message too.
    const identity = sha256(o.server.href, o.apiKey ?? "", o.spaceId ?? "", ctx.session ?? "", ctx.cwd ?? "", ctx.protocol, ctx.session ? "" : first);
    const safe = (ctx.session ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const threadId = safe ? `magpie-${safe}-${identity.slice(0, 8)}` : `magpie-${identity.slice(0, 32)}`;
    // A client's environment notice is a user message before the real prompt.
    // The title is the message Magpie read as the query, kept for the Thread.
    const query = (ctx.query ?? "").trim();
    // A client's own notice can be the first user message; the last user turn
    // is a better title when Magpie has no query for this protocol.
    const opening = (query && users.find((m) => m.content.includes(query))?.content) || users.at(-1)?.content || first;
    return {
        o, send: client(o), body: structuredClone(body), threadId,
        hostAgentId: hostAgentOf(o, ctx),
        title: titles.get(threadId) ?? titleOf([{ role: "user", content: opening }]),
    };
}
export function onResponse(reply, ctx) {
    const state = ctx.state?.nowledgeMem;
    if (!state || ctx.success === false || !state.o.capture)
        return;
    // The host's notification is best-effort and not awaited: the import fails
    // open, and its outcome is reported, never thrown at the client.
    return capture(reply, ctx, state).catch((error) => {
        ctx.report?.(error instanceof Failure ? error.code : "invalid");
    });
}
async function capture(reply, ctx, state) {
    const body = ctx.request ?? state.body;
    const captured = transcript(body, reply, ctx.protocol);
    if (!captured)
        return;
    // Credentials anywhere in the conversation stop the whole capture.
    if (hasSecret(captured.messages))
        return;
    const messages = importMessages(captured.messages, state, ctx.agent);
    if (state.o.captureFilter === "human" && !messages.some((m) => m.role === "user")) {
        ctx.report?.("skipped");
        return;
    }
    if (!messages.length)
        return;
    const content = JSON.stringify(messages);
    if (utf8(content) > maxImport) {
        ctx.report?.("skipped");
        return;
    }
    if (sent.get(state.threadId)?.text === content) {
        ctx.report?.("skipped");
        return;
    }
    const metadata = { source_app: "magpie", protocol: ctx.protocol };
    if (ctx.session)
        metadata.session_id = sha256(ctx.session);
    if (ctx.cwd)
        metadata.cwd = sha256(resolve(ctx.cwd));
    if (state.o.agentId)
        metadata.agent_id = state.o.agentId;
    if (state.hostAgentId)
        metadata.host_agent_id = state.hostAgentId;
    if (ctx.agent)
        metadata.agent = ctx.agent;
    const payload = {
        thread_id: state.threadId,
        // In human mode the first retained user text names the Thread, not
        // a host preamble. Keep that title once the import is acknowledged.
        title: state.o.captureFilter === "human"
            ? titles.get(state.threadId) ?? titleOf(messages)
            : state.title || titleOf(messages),
        source: "magpie",
        messages,
        metadata,
        tool_version: `magpie-nowledge-mem/${version}`,
    };
    if (state.o.spaceId)
        payload.space_id = state.o.spaceId;
    const answer = await state.send("POST", "threads/import", payload, ctx.signal);
    const result = answer.body?.results?.[0];
    if (!answer.body?.success || answer.body.failed_count > 0 || result?.success === false) {
        // A Thread deleted in Mem is recreated from the next completed turn.
        if (result?.error_code === "thread_not_found")
            sent.delete(state.threadId);
        throw new Failure("invalid", answer.status);
    }
    rememberSent(state.threadId, content);
    titles.delete(state.threadId);
    titles.set(state.threadId, payload.title);
    while (titles.size > maxSessions)
        titles.delete(titles.keys().next().value);
    ctx.report?.("ready", utf8(content));
}
// importMessages keeps what a person and the assistant wrote. Client tool
// results follow when captureTools is on and the filter is off; tool-only
// assistant steps and our own recalled blocks are not conversation messages.
function importMessages(messages, state, agent) {
    const out = [];
    messages.forEach((message, index) => {
        const projected = captureMessage(message, state.o, agent);
        if (!projected)
            return;
        const human = state.o.captureFilter === "human";
        const content = human ? projected.content : projected.content.trim();
        if (!content.trim())
            return;
        if (!human && !state.o.captureTools && (message.role === "tool" || message.tool_calls?.length))
            return;
        // Use the original occurrence index, not the filtered array index:
        // hash normalized source text so policy changes preserve legacy off-mode IDs.
        const metadata = { ...projected.metadata, external_id: `magpie:${sha256(state.threadId, String(index), message.role, message.content.trim()).slice(0, 24)}` };
        if (message.role === "tool") {
            if (message.name)
                metadata.tool_name = message.name;
            if (message.tool_call_id)
                metadata.tool_call_id = message.tool_call_id;
        }
        out.push({ role: message.role, content, metadata });
    });
    return out;
}
function rememberSent(threadId, text) {
    sent.delete(threadId);
    sent.set(threadId, { text, bytes: utf8(text) });
    trimCache(sent, 32 << 20);
    while (sent.size > maxSessions)
        sent.delete(sent.keys().next().value);
}
function titleOf(messages) {
    for (const message of messages) {
        if (message.role !== "user")
            continue;
        const line = message.content.split(/\r?\n/u).map((l) => l.trim()).find(Boolean);
        if (line)
            return Array.from(line).slice(0, 80).join("");
    }
    return "Magpie conversation";
}
// Inspect message text and tool arguments before the outer transcript is
// serialized. Structured tool values need their field names checked too.
function hasSecret(value) {
    if (typeof value === "string") {
        if (secret.test(value))
            return true;
        if (/^\s*[\[{]/u.test(value)) {
            try { return hasSecret(JSON.parse(value)); } catch { /* plain text */ }
        }
        return false;
    }
    if (!value || typeof value !== "object")
        return false;
    return Object.entries(value).some(([key, item]) => secret.test(`${key}: ${typeof item === "string" ? item : "[value]"}`) || hasSecret(item));
}
// --- small things ---
function trimCache(map, limit) {
    let bytes = [...map.values()].reduce((total, value) => total + (value.bytes ?? 0), 0);
    for (const [key, value] of map) {
        if (bytes <= limit)
            break;
        map.delete(key);
        bytes -= value.bytes ?? 0;
    }
}
function lru(map, key, make, max) {
    let v = map.get(key);
    if (v === undefined)
        v = make();
    else
        map.delete(key);
    map.set(key, v);
    while (map.size > max)
        map.delete(map.keys().next().value);
    return v;
}
