import { call } from './tailnet.mjs';

// The phone reaches the service through a forwarding of Tailscale: the port
// of the service is published inside the tailnet and points at this computer.
// The forwarding of another service on the same port is never touched.
const targetFor = port => '127.0.0.1:' + port;

export async function serveState() {
  const result = await call(['serve', 'status', '--json']);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'tailscale serve status did not answer with JSON.' };
  }
}

export async function planForward(port) {
  const status = await serveState();
  if (!status.ok) return { ok: false, error: status.error };
  const existing = status.data?.state?.TCP?.[String(port)];
  if (existing && existing.TCPForward !== targetFor(port)) {
    return { ok: false, error: `端口 ${port} 上已经有别的转发，没有动它。` };
  }
  const commands = existing
    ? []
    : [['serve', '--bg', '--tcp=' + port, 'tcp://' + targetFor(port)]];
  return { ok: true, commands, ready: true };
}

export async function applyForward(port) {
  const plan = await planForward(port);
  if (!plan.ok) return plan;
  for (const command of plan.commands) {
    const result = await call(command);
    if (!result.ok) return { ok: false, error: result.error };
  }
  return { ok: true };
}

// Only a forwarding that points at this service is removed.
export async function removeForward(port) {
  const status = await serveState();
  const existing = status.ok ? status.data?.state?.TCP?.[String(port)] : null;
  if (!existing || existing.TCPForward !== targetFor(port)) {
    return { ok: false, error: '没有找到属于这个插件的转发。' };
  }
  const result = await call(['serve', '--tcp=' + port, 'off']);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
