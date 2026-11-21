import { createServer, } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, readConfig, saveConfig, validateConfig, withLock, jsonFile, } from "./config.js";
import { setToken, resolveToken } from "./credentials.js";
import { readUsage } from "./usage.js";
import { renderCard, readmeSnippet } from "./renderer.js";
import { sync, readState, localDate } from "./sync.js";
import { installSchedule, uninstallSchedule } from "./scheduler.js";
import { GitHub } from "./github.js";
const ui = fileURLToPath(new URL("../ui/", import.meta.url));
async function body(req) {
    let text = "";
    for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 16384)
            throw new Error("请求过大。");
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("请求不是有效 JSON。");
    }
}
export async function startServer({ port = 3498, dir = dataDir(), } = {}) {
    const token = randomBytes(32).toString("hex");
    let origin = "";
    const server = createServer(async (req, res) => {
        const send = (status, value, type = "application/json; charset=utf-8") => {
            res.writeHead(status, { "Content-Type": type });
            res.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
        };
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== new URL(origin).host)
            return send(403, { error: "Host rejected" });
        const url = new URL(req.url || "/", origin), path = url.pathname;
        if (path.startsWith("/api/")) {
            const requestOrigin = req.headers.origin;
            if (requestOrigin && requestOrigin !== "null" && requestOrigin !== origin)
                return send(403, { error: "Origin rejected" });
            if (requestOrigin) {
                res.setHeader("Access-Control-Allow-Origin", requestOrigin);
                res.setHeader("Vary", "Origin");
            }
            if (req.method === "OPTIONS") {
                res.setHeader("Access-Control-Allow-Methods", "GET, POST");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Magpie-Stats-Token");
                return send(204, "");
            }
            const supplied = req.headers["x-magpie-stats-token"];
            if (typeof supplied !== "string" ||
                Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
                !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)))
                return send(403, { error: "Page token required" });
            try {
                if (path === "/api/status" && req.method === "GET")
                    return send(200, {
                        config: await readConfig(dir),
                        state: await readState(dir),
                        schedule: await jsonFile(join(dir, "schedule.json"), {
                            installed: false,
                        }),
                    });
                if (path === "/api/preview" && req.method === "POST") {
                    const c = validateConfig((await body(req)).config), stats = await readUsage(c);
                    return send(200, {
                        light: renderCard(stats, c, "light", localDate()),
                        dark: renderCard(stats, c, "dark", localDate()),
                        requests: stats.requests,
                        tokens: stats.tokens,
                        activeDays: stats.activeDays,
                    });
                }
                if (path === "/api/config" && req.method === "POST") {
                    const data = await body(req), c = validateConfig(data.config);
                    await withLock(dir, async () => {
                        if (data.token) {
                            await setToken(data.token, dir);
                            c.credentialSource = "keychain";
                        }
                        const old = await readConfig(dir);
                        if (c.daily && !c.repository)
                            throw new Error("开启每日同步前请填写仓库。");
                        // Verify credentials and repository without creating any remote files.
                        if (c.daily)
                            await new GitHub(await resolveToken(c, dir)).repository(c);
                        await saveConfig(c, dir);
                        try {
                            const schedule = await jsonFile(join(dir, "schedule.json"), {});
                            if (c.daily && !schedule.installed)
                                await installSchedule(dir);
                            else if (!c.daily && schedule.installed)
                                await uninstallSchedule(dir);
                        }
                        catch (e) {
                            await saveConfig({ ...c, daily: old.daily }, dir);
                            throw e;
                        }
                    });
                    return send(200, { saved: true });
                }
                if (path === "/api/sync" && req.method === "POST")
                    return send(200, await sync(dir));
                if (path === "/api/readme" && req.method === "GET") {
                    const c = await readConfig(dir);
                    let branch = c.branch;
                    if (!branch && c.repository)
                        branch = (await new GitHub(await resolveToken(c, dir)).repository(c)).branch;
                    return send(200, { html: readmeSnippet(c, branch || "main") });
                }
                return send(404, { error: "Not found" });
            }
            catch (e) {
                return send(400, {
                    error: e instanceof Error ? e.message : "操作失败。",
                });
            }
        }
        if (req.method !== "GET")
            return send(405, "Method not allowed", "text/plain");
        const files = {
            "/": ["index.html", "text/html; charset=utf-8"],
            "/app.js": ["app.js", "text/javascript; charset=utf-8"],
            "/style.css": ["style.css", "text/css; charset=utf-8"],
        };
        const entry = files[path];
        if (!entry)
            return send(404, "Not found", "text/plain");
        res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self' ${origin}; style-src 'self' ${origin}; img-src data: blob:; connect-src 'self' ${origin}; base-uri 'none'; form-action 'none'; object-src 'none'`);
        try {
            const source = await readFile(join(ui, entry[0]), "utf8");
            return send(200, source.replace("__PAGE_TOKEN__", token), entry[1]);
        }
        catch {
            return send(500, "UI unavailable", "text/plain");
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("无法启动本地服务。");
    origin = `http://127.0.0.1:${address.port}`;
    return {
        server,
        url: origin,
        close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
}
