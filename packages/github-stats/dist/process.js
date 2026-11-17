import { spawn } from "node:child_process";
export function run(command, args, input = "", timeout = 30_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const out = [];
        let size = 0;
        const timer = setTimeout(() => {
            child.kill();
        }, timeout);
        child.stdout.on("data", (b) => {
            size += b.length;
            if (size < 2_000_000)
                out.push(b);
            else
                child.kill();
        });
        // Do not include subprocess stderr: credential utilities can echo secrets.
        child.stderr.resume();
        child.stdin.on("error", () => { });
        child.on("error", () => {
            clearTimeout(timer);
            reject(new Error("系统工具不可用或无法启动。"));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            code === 0
                ? resolve(Buffer.concat(out).toString("utf8").trim())
                : reject(new Error("系统操作失败，请检查系统权限或凭据库是否已解锁。"));
        });
        child.stdin.end(input);
    });
}
