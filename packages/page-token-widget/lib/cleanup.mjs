import path from 'node:path';
import { readFileSync } from 'node:fs';
import { removeForwardSync } from './forward.mjs';
import { DATA_DIR } from './paths.mjs';

// The last way out. When the program ends, the sockets go with it, but the
// forwarding of Tailscale is a setting of Tailscale and would stay behind.
// It is taken away here, and only when it still points where this plugin
// left it: a forwarding of somebody else is never touched.
//
// It lives in its own file and not in index.mjs so that the entry of the
// plugin exports nothing but the plugin itself: the community's own check
// loads every package the way OpenCode does, and a main that exports a
// plain function is taken for a plugin there.
export function cleanupForward(directory, runner) {
  try {
    if (!directory) return { ok: false, error: '没有数据目录。' };
    const file = path.join(directory, DATA_DIR, 'state.json');
    const record = JSON.parse(readFileSync(file, 'utf8'))?.forward;
    if (!record) return { ok: true, skipped: true };
    return removeForwardSync(record.publishedPort, record, runner);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
