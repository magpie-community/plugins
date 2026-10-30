// The Nowledge Mem connection for the gateway hook: how the endpoint and
// credential are resolved, how a request is made and bounded, and the small
// helpers the hook needs. The page, the hook and Mem's own clients read the
// same options and environment, so they never disagree about where Mem is or
// which Space they speak to.
import { createHash } from "node:crypto";

// Bumped with package.json: Mem's own clients record it on imported Threads.
export const version = "0.1.0";

// The only report codes magpie's Plugins page shows; tools turn these into
// messages, never the service's own text.
export class MemFailure extends Error {
    code;
    status;
    constructor(code, status = 0) {
        super(`Nowledge Mem ${code}`);
        this.code = code;
        this.status = status;
    }
}

// Mem search answers carry per-hit debug metadata: 20 hits can reach ~110 KiB.
const maxResponseBytes = 512 << 10;

export function resolveOptions(raw = {}, env = process.env) {
    const text = (v) => {
        if (v === undefined || v === null || v === "")
            return undefined;
        if (typeof v !== "string" || !v.trim())
            throw new MemFailure("invalid");
        return v;
    };
    const bool = (name, fallback) => {
        if (raw[name] !== undefined && typeof raw[name] !== "boolean")
            throw new MemFailure("invalid");
        return raw[name] ?? fallback;
    };
    const integer = (name, fallback, min, max) => {
        const value = raw[name] ?? fallback;
        if (!Number.isInteger(value) || value < min || value > max)
            throw new MemFailure("invalid");
        return value;
    };
    // The Mem endpoint, as its own clients resolve it: the option, then the
    // portable NMEM_API_URL, then the local desktop default. A URL from the
    // environment that isn't an HTTP(S) address is ignored rather than fatal.
    const configured = text(raw.serverUrl);
    let serverUrl = configured;
    if (!configured) {
        let fromEnv;
        try { fromEnv = text(env.NMEM_API_URL); } catch { /* unusable */ }
        for (const candidate of [fromEnv, "http://127.0.0.1:14242"]) {
            try {
                if (candidate && ["https:", "http:"].includes(new URL(candidate).protocol)) {
                    serverUrl = candidate;
                    break;
                }
            }
            catch { /* next candidate */ }
        }
    }
    if (!serverUrl)
        throw new MemFailure("invalid");
    let server;
    try {
        server = new URL(serverUrl);
    }
    catch {
        throw new MemFailure("invalid");
    }
    // a credential is never sent in clear text to another machine, kept in a
    // URL that logs show, or followed through a redirect
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname);
    if (server.username || server.password || server.search || server.hash || !["https:", "http:"].includes(server.protocol) ||
        (server.protocol === "http:" && !loopback && raw.allowInsecureHttp !== true))
        throw new MemFailure("invalid");
    server.pathname = server.pathname.replace(/\/$/, "") + "/";
    const apiKeyEnv = text(raw.apiKeyEnv) ?? "NMEM_API_KEY";
    if (!/^NMEM_[A-Za-z0-9_]+$/u.test(apiKeyEnv))
        throw new MemFailure("invalid");
    const apiKey = bearer(text(raw.apiKey) ?? text(env[apiKeyEnv]));
    if (apiKey && /[\s\u0000-\u001f\u007f]/u.test(apiKey))
        throw new MemFailure("invalid");
    return {
        server, apiKey, apiKeyEnv,
        spaceId: text(raw.spaceId),
        agentId: text(raw.agentId),
        hostAgentId: text(raw.hostAgentId),
        recall: bool("recall", true),
        contextBundle: bool("contextBundle", true),
        capture: bool("capture", false),
        captureTools: bool("captureTools", true),
        maxMemories: integer("maxMemories", 5, 1, 20),
        maxBytes: integer("maxBytes", 6000, 512, 32768),
        requestTimeoutMs: integer("requestTimeoutMs", 1500, 50, 5000),
        recallBackoffMs: integer("recallBackoffMs", 30_000, 100, 300_000),
    };
}

// request sends to the configured Mem only, reads a bounded reply and decodes
// it strictly. A status in `expected` comes back without its body, so
// "nothing there" is told from a failure. Failures use Mem's small outcome
// vocabulary; the caller decides what each means for it.
export async function request(o, { method, route, payload, signal, timeoutMs, expected = [], fetch: fetcher = fetch }) {
    const headers = { "User-Agent": `magpie-nowledge-mem/${version}`, Accept: "application/json" };
    if (payload !== undefined)
        headers["Content-Type"] = "application/json";
    if (o.apiKey)
        headers.Authorization = `Bearer ${o.apiKey}`;
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
        combined.throwIfAborted();
        let r;
        try {
            r = await fetcher(new URL(route, o.server), {
                method, headers, signal: combined, redirect: "error",
                body: payload === undefined ? undefined : JSON.stringify(payload),
            });
        }
        catch {
            throw new MemFailure("unavailable");
        }
        if (r.ok)
            return { status: r.status, body: await json(r) };
        await r.body?.cancel();
        if (expected.includes(r.status))
            return { status: r.status, body: undefined };
        if (r.status === 401 || r.status === 403)
            throw new MemFailure("unauthorized", r.status);
        if (r.status === 400)
            throw new MemFailure(o.spaceId ? "unbound" : "invalid", r.status);
        if (r.status === 404)
            throw new MemFailure("notfound", r.status);
        if (r.status === 409 || r.status === 422)
            throw new MemFailure("invalid", r.status);
        throw new MemFailure("unavailable", r.status);
    }
    catch (error) {
        // The client's own cancellation keeps its reason, not ours.
        signal?.throwIfAborted();
        if (deadline.aborted)
            throw new MemFailure("unavailable");
        throw error;
    }
}

async function json(r) {
    const reader = r.body?.getReader();
    if (!reader)
        throw new MemFailure("invalid", r.status);
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            let part;
            try { part = await reader.read(); }
            catch { throw new MemFailure("unavailable", r.status); }
            const { value, done } = part;
            if (done)
                break;
            size += value.byteLength;
            if (size > maxResponseBytes) {
                await reader.cancel();
                throw new MemFailure("invalid", r.status);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    }
    catch {
        throw new MemFailure("invalid", r.status);
    }
}

export function bearer(value) {
    if (!value)
        return undefined;
    return value.replace(/^Bearer\s+/iu, "").trim() || undefined;
}

export function serviceKey(o) { return sha256(o.server.href, o.apiKey ?? "", o.spaceId ?? ""); }
export function sha256(...parts) { return createHash("sha256").update(parts.join("\0")).digest("hex"); }
export function utf8(text) { return Buffer.byteLength(text, "utf8"); }

// trimText cuts at a UTF-8 boundary and marks the cut, so a tool's output and
// a recall block stay inside their budgets.
export function trimText(text, max) {
    if (utf8(text) <= max)
        return text;
    let out = "", bytes = 0;
    for (const ch of text) {
        const size = utf8(ch);
        if (bytes + size > max - 3)
            break;
        out += ch;
        bytes += size;
    }
    return `${out}…`;
}
