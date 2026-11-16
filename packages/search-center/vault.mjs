import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CATALOG, fault } from "./catalog.mjs";
import { pythonCommand } from "./runtime.mjs";

const helper = fileURLToPath(new URL("local_secrets.py", import.meta.url));
export function secretOperation(request) {
  if (process.platform !== "win32") {
    return Promise.reject(fault("本机 DPAPI 密钥加密仅支持 Windows；其他系统可使用公开来源、SearXNG 或 bw:// 凭据引用", "UNSUPPORTED_PLATFORM", 400));
  }
  return new Promise((resolve, reject) => {
    const python = pythonCommand();
    const child = spawn(python.file, [...python.args, "-B", helper], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }, signal: AbortSignal.timeout(15000),
    });
    let output = "", settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      if (err?.code === "ENOENT") return reject(fault("未找到 Python 3.12+ 运行环境，请先按说明安装 Python 依赖", "PYTHON_MISSING", 503));
      reject(fault("本机密钥存储操作失败，请重试", "LOCAL_SECRET", 503));
    };
    child.on("error", fail); child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 500_000) child.kill(); });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) return fail();
      try { settled = true; resolve(JSON.parse(output)); } catch { fail(); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export class LocalVault {
  constructor(store, operation = secretOperation) { this.store = store; this.operation = operation; }
  async protect(channel, value) {
    if (!CATALOG[channel]?.keyEnv || typeof value !== "string" || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value))
      throw fault("请填写有效 API Key，每条密钥单独添加");
    const id = randomUUID();
    const { cipher } = await this.operation({ op: "protect", channel, id, value });
    return { id, channel, cipher };
  }
  cipher(channel, key) {
    const entry = this.store.read("credentials.encrypted.json", {})[key.ref?.slice(8)];
    if (!entry || entry.channel !== channel) throw fault("密钥不存在或不属于该渠道", "KEY_OWNER", 400);
    return { id: key.ref.slice(8), cipher: entry.cipher };
  }
  persist(entries) {
    const data = this.store.read("credentials.encrypted.json", {});
    for (const e of entries) if (e.cipher) data[e.id] = { channel: e.channel, cipher: e.cipher };
    this.store.write("credentials.encrypted.json", data);
  }
  prune(policy) {
    const keep = new Set(Object.values(policy.channels).flatMap(c => c.keys).filter(k => k.ref.startsWith("local://")).map(k => k.ref.slice(8)));
    const data = this.store.read("credentials.encrypted.json", {});
    const remaining = Object.fromEntries(Object.entries(data).filter(([id]) => keep.has(id)));
    if (Object.keys(remaining).length !== Object.keys(data).length) this.store.write("credentials.encrypted.json", remaining);
  }
}
