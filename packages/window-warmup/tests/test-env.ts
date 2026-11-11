import { tmpdir } from "node:os";
import { join } from "node:path";

export function pinMagpieDirsForTest(): () => void {
  const inherited = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(tmpdir(), "window-warmup-test-magpie-config");
  process.env.XDG_CACHE_HOME = join(tmpdir(), "window-warmup-test-magpie-cache");
  return () => {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
