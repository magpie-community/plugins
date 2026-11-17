import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
export const defaults = {
    repository: "",
    branch: "",
    folder: "assets",
    period: "30d",
    theme: "aurora",
    width: 520,
    topModels: 3,
    showCost: false,
    showTrend: true,
    showHeatmap: true,
    showModels: true,
    daily: false,
    magpiePort: 3425,
    credentialSource: "keychain",
};
export function dataDir() {
    return resolve(process.env.MAGPIE_STATS_HOME ||
        join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie-github-stats"));
}
export async function jsonFile(file, fallback) {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return fallback;
        throw new Error("本地配置损坏，请检查配置文件。");
    }
}
export async function atomicWrite(file, value) {
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(tmp, value, { mode: 0o600, flag: "wx" });
        await rename(tmp, file);
    }
    finally {
        await rm(tmp, { force: true });
    }
}
export function validateConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("配置必须是对象。");
    const r = raw;
    for (const k of Object.keys(r))
        if (!Object.hasOwn(defaults, k))
            throw new Error("配置包含不支持的字段；Token 必须单独保存。");
    const c = { ...defaults, ...r };
    if (typeof c.repository !== "string" ||
        (c.repository &&
            !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(c.repository)))
        throw new Error("仓库格式应为 owner/repo。");
    if (typeof c.branch !== "string" ||
        c.branch.length > 200 ||
        /[\s~^:?*\[\\\x00-\x1f]/.test(c.branch) ||
        c.branch.includes("..") ||
        c.branch.includes("@{") ||
        c.branch.startsWith("/") ||
        c.branch.endsWith("/") ||
        c.branch.endsWith(".") ||
        c.branch.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock")))
        throw new Error("分支名称无效。");
    if (typeof c.folder !== "string" ||
        c.folder.length > 200 ||
        !/^[A-Za-z0-9_./-]*$/.test(c.folder) ||
        c.folder.split("/").some((s) => [".", "..", ".git"].includes(s)) ||
        c.folder.startsWith("/") ||
        c.folder.endsWith("/") ||
        c.folder.includes("//"))
        throw new Error("输出文件夹必须是安全的仓库相对路径。");
    if (!["7d", "30d", "all"].includes(c.period) ||
        !["aurora", "minimal", "cyberpunk"].includes(c.theme))
        throw new Error("统计周期或主题无效。");
    if (!["keychain", "github-cli"].includes(c.credentialSource))
        throw new Error("凭据来源无效。");
    if (!Number.isInteger(c.width) ||
        c.width < 320 ||
        c.width > 800 ||
        !Number.isInteger(c.topModels) ||
        c.topModels < 3 ||
        c.topModels > 5)
        throw new Error("宽度须为 320–800，模型数须为 3–5。");
    for (const key of [
        "showCost",
        "showTrend",
        "showHeatmap",
        "showModels",
        "daily",
    ])
        if (typeof c[key] !== "boolean")
            throw new Error("开关值无效。");
    if (!Number.isInteger(c.magpiePort) ||
        c.magpiePort < 1 ||
        c.magpiePort > 65535)
        throw new Error("Magpie 端口无效。");
    return c;
}
export async function readConfig(dir = dataDir()) {
    const raw = await jsonFile(join(dir, "config.json"), {});
    if (raw.magpiePort === undefined) {
        const s = await jsonFile(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie", "settings.json"), {});
        if (Number.isInteger(s.port))
            raw.magpiePort = s.port;
    }
    return validateConfig(raw);
}
export async function saveConfig(raw, dir = dataDir()) {
    const c = validateConfig(raw);
    await atomicWrite(join(dir, "config.json"), JSON.stringify(c, null, 2));
    return c;
}
export async function withLock(dir, work) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "operation.lock");
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            handle = await open(path, "wx", 0o600);
            await handle.writeFile(String(process.pid));
            break;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            const pid = Number(await readFile(path, "utf8").catch(() => ""));
            // A new owner may not have written its PID yet. Never remove that lock.
            if (!Number.isSafeInteger(pid) || pid < 1)
                throw new Error("另一个操作正在进行，请稍后重试。");
            try {
                process.kill(pid, 0);
                throw new Error("另一个操作正在进行，请稍后重试。");
            }
            catch (err) {
                if (err.code !== "ESRCH")
                    throw err;
            }
            await rm(path, { force: true });
        }
    }
    if (!handle)
        throw new Error("无法取得操作锁。");
    try {
        return await work();
    }
    finally {
        await handle.close();
        await rm(path, { force: true });
    }
}
