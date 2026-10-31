// Startup warm-up: for enabled, non-planned Providers, detect then fetch models; results go into infoCache.
import type { Settings } from "../store/settings.js";
import { listProviders } from "./registry.js";
import { catalogById } from "./catalog.js";
import { isProviderEnabled } from "./enabled.js";
import { cachedDetect, cachedModels } from "./infoCache.js";

export async function warmProviderCache(settings: Settings): Promise<void> {
  await Promise.all(
    listProviders().map(async (p) => {
      if (!isProviderEnabled(settings, p.id) || catalogById(p.id)?.status === "planned") return;
      const det = await cachedDetect(p);
      if (det.available) await cachedModels(p);
    }),
  );
}
