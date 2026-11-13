import { call } from './tailnet.mjs';

// The phone reaches the service through a forwarding of Tailscale: the port
// of the service is published inside the tailnet and points at this computer.
// The forwarding of another service on the same port is never touched.
//
// The published port and the port it points at are not the same one. The
// console of this computer keeps the published port on the loopback address,
// and the phone side gets a port of its own, so a request that arrives
// through the tailnet can never be mistaken for one from this computer.
export const targetFor = port => '127.0.0.1:' + port;

export async function serveState() {
  const result = await call(['serve', 'status', '--json']);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'tailscale serve status did not answer with JSON.' };
  }
}

// The status of Tailscale lists the published ports under "TCP".
export const publishedFor = (status, port) => status?.data?.TCP?.[String(port)] || null;

export async function planForward(publishedPort, phonePort) {
  const status = await serveState();
  if (!status.ok) return { ok: false, error: status.error };
  const existing = publishedFor(status, publishedPort);
  const target = targetFor(phonePort);
  // An older version of this plugin pointed the published port at the console
  // of this computer. That forwarding is ours as well, and it is moved to the
  // phone side.
  const legacy = targetFor(publishedPort);
  if (existing && existing.TCPForward !== target && existing.TCPForward !== legacy) {
    return { ok: false, error: `端口 ${publishedPort} 上已经有别的转发，没有动它。` };
  }
  const commands = existing && existing.TCPForward === target
    ? []
    : [['serve', '--bg', '--tcp=' + publishedPort, 'tcp://' + target]];
  return { ok: true, commands, ready: true };
}

export async function applyForward(publishedPort, phonePort) {
  const plan = await planForward(publishedPort, phonePort);
  if (!plan.ok) return plan;
  for (const command of plan.commands) {
    const result = await call(command);
    if (!result.ok) return { ok: false, error: result.error };
  }
  return { ok: true };
}

// Only a forwarding that points at this service is removed.
export async function removeForward(publishedPort, phonePort) {
  const status = await serveState();
  const existing = status.ok ? publishedFor(status, publishedPort) : null;
  const ours = existing && (
    existing.TCPForward === targetFor(phonePort) ||
    existing.TCPForward === targetFor(publishedPort)
  );
  if (!ours) {
    return { ok: false, error: '没有找到属于这个插件的转发。' };
  }
  const result = await call(['serve', '--tcp=' + publishedPort, 'off']);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
