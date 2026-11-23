import { configError, configHomePath, configOperations, runConfigOperation } from './server.mjs';

const [operation, home, ...extra] = process.argv.slice(2);
const badRequest = message => Object.assign(new Error(message), { status: 400, error: 'rejected' });
let response;
try {
  if (extra.length || !configOperations.has(operation) || !configHomePath(home)) {
    throw badRequest('用法：firstmate-config.mjs <受支持的操作> <绝对 Home 路径>，从标准输入读取 JSON。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw badRequest('请求超出大小限制。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw badRequest('标准输入必须是 UTF-8 JSON。'); }
  response = { ok: true, result: await runConfigOperation(operation, home, body) };
} catch (error) {
  response = { ok: false, ...configError(error) };
}
// Domain errors are JSON replies. An SSH/CLI failure produces no such reply.
process.stdout.write(`${JSON.stringify(response)}\n`);
