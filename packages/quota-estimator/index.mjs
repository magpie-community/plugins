import { publish } from "./collector.mjs";

let started = false;
export default async function quotaEstimator() {
  if (!started) {
    started = true;
    let running = false;
    const update = async () => {
      if (running) return;
      running = true;
      try { await publish(); }
      catch { console.error("quota-estimator: 无法写入估算快照，请检查插件目录权限"); }
      finally { running = false; }
    };
    void update();
    setInterval(update, 60000).unref?.();
  }
  // No provider, auth, config or gateway hooks: this plugin never participates in routing.
  return {};
}
