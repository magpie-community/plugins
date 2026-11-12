import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATALOG, fault } from "./catalog.mjs";
import { pythonCommand, DATA } from './runtime.mjs';

const WORKER = fileURLToPath(new URL("worker.py", import.meta.url));
export function commandFor(channel, key) {
  const env = CATALOG[channel]?.keyEnv;
  if (key && (!env || !/^bw:\/\/[^/\r\n\0]+\/[^/\r\n\0]+$/.test(key.ref))) throw fault("无效凭据引用");
  const python=pythonCommand();
  return key ? {file:'secret-run',args:['--env',`${env}=${key.ref}`,'--',python.file,...python.args,'-B','-u',WORKER]}
    : {file:python.file,args:[...python.args,'-B','-u',WORKER]};
}
export function runCredential(channel, key, args, baseUrl, signal, encrypted) {
  const command = commandFor(channel, encrypted ? null : key);
  return new Promise((resolve, reject) => {
    let out = "", size = 0, settled = false;
    // Query and non-secret endpoint are stdin, never a shell command.
    const child = spawn(command.file, command.args, {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      signal, env: { ...process.env, PYTHONIOENCODING: "utf-8", SEARCH_CENTER_DATA_DIR:DATA },
    });
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    child.on("error", () => fail(fault(signal?.aborted ? "调用已取消或超时" : "凭据服务无法启动", "CREDENTIAL_START", 503)));
    child.stderr.on("data", () => {}); // Secret-run diagnostics may include private values: never forward them.
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 2_000_000) { child.kill(); fail(fault("响应超过大小限制", "RESPONSE_LIMIT", 502)); return; }
      out += chunk.toString("utf8");
    });
    child.on("close", code => {
      if (settled) return;
      if (code === 126) return fail(fault("你拒绝了凭据解锁；本次停止，不尝试其他密钥", "UNLOCK_REFUSED", 403));
      if (code === 125) return fail(fault("凭据未配置、条目不存在或解锁服务不可用，请检查条目和字段", "SECRET_RUN_ERROR", 503));
      if (code !== 0) return fail(fault("凭据调用失败，请检查凭据服务和网络", "CREDENTIAL_FAILED", 502));
      try {
        const line = out.split(/\r?\n/).findLast(x => x.startsWith('{"result":'));
        const payload = JSON.parse(line);
        settled = true; resolve(payload.result);
      } catch { fail(fault("凭据服务返回格式不正确", "CREDENTIAL_RESPONSE", 502)); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ channel, baseUrl, args, injected:Boolean(key && !encrypted), ...(encrypted ? { encrypted } : {}) }));
  });
}
