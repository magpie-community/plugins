import { call, callSync } from './tailnet.mjs';

// The phone reaches the service through a forwarding of Tailscale: the port
// of the service is published inside the tailnet and points at this computer.
// The forwarding of another service on the same port is never touched.
//
// The published port and the port it points at are not the same one. The
// console of this computer keeps the published port on the loopback address,
// and the phone side gets a port of its own, so a request that arrives
// through the tailnet can never be mistaken for one from this computer.
export const targetFor = port => '127.0.0.1:' + port;

export async function serveState(runner) {
  const result = await call(['serve', 'status', '--json'], 15000, runner);
  if (!result.ok) return { ok: false, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'tailscale serve status did not answer with JSON.' };
  }
}

// The status of Tailscale lists the published ports under "TCP".
export const publishedFor = (status, port) => status?.data?.TCP?.[String(port)] || null;

// What the plugin writes down about the forwarding it made, so a forwarding
// that was made by hand is never taken away and a forwarding of an older
// version can be found again after a restart.
export const forwardRecord = (publishedPort, phonePort, extra = {}) => ({
  publishedPort,
  phonePort,
  target: targetFor(phonePort),
  createdAt: new Date().toISOString(),
  ...extra,
});

// The plan of the forwarding. It never changes anything by itself: it says
// what has to be run.
export function planForward(publishedPort, phonePort, status, owned = null) {
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
  return {
    ok: true,
    commands,
    ready: true,
    target,
    // A forwarding that was already there and points at us is taken over and
    // written down, so it is known to be ours afterwards.
    adopted: Boolean(existing) && !owned,
    legacy: Boolean(existing) && existing.TCPForward === legacy,
  };
}

export async function applyForward(publishedPort, phonePort, runner, owned = null) {
  const status = await serveState(runner);
  if (!status.ok) return { ok: false, error: status.error };
  const plan = planForward(publishedPort, phonePort, status, owned);
  if (!plan.ok) return plan;
  for (const command of plan.commands) {
    const result = await call(command, 15000, runner);
    if (!result.ok) return { ok: false, error: result.error };
  }
  return { ok: true, target: plan.target, adopted: plan.adopted, legacy: plan.legacy };
}

// Only a forwarding that is written down as ours, and that still points where
// it was pointed, is removed.
export async function removeForward(publishedPort, phonePort, runner, owned = null) {
  const status = await serveState(runner);
  const existing = status.ok ? publishedFor(status, publishedPort) : null;
  const recorded = owned && owned.publishedPort === publishedPort ? owned : null;
  const target = recorded?.target || null;
  if (!existing || !target || existing.TCPForward !== target) {
    return { ok: false, error: '没有找到属于这个插件的转发。' };
  }
  const result = await call(['serve', '--tcp=' + publishedPort, 'off'], 15000, runner);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

// The last way out of a run: the forwarding is taken away when the program
// ends. The rule is the same one — only a forwarding that is written down as
// ours and that still points where it was pointed is taken away.
export function removeForwardSync(publishedPort, owned, runner) {
  if (!owned || owned.publishedPort !== publishedPort) {
    return { ok: false, error: '没有找到属于这个插件的转发。' };
  }
  const status = callSync(['serve', 'status', '--json'], 15000, runner);
  if (!status.ok) return { ok: false, error: status.error };
  let existing = null;
  try {
    existing = publishedFor({ data: JSON.parse(status.stdout) }, publishedPort);
  } catch {
    return { ok: false, error: 'tailscale serve status did not answer with JSON.' };
  }
  if (!existing || existing.TCPForward !== owned.target) {
    return { ok: false, error: '没有找到属于这个插件的转发。' };
  }
  const result = callSync(['serve', '--tcp=' + publishedPort, 'off'], 15000, runner);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
