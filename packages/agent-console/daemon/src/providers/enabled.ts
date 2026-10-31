// Whether the user enabled this Provider in settings.
// Never toggled by hand: catalog status=verified is on by default, others off; entries outside the catalog (mock etc.) are on.
import type { Settings } from "../store/settings.js";
import { catalogById } from "./catalog.js";

export function isProviderEnabled(settings: Settings, id: string): boolean {
  const m = settings.providerEnabled;
  if (m && typeof m === "object" && typeof m[id] === "boolean") return m[id];
  const entry = catalogById(id);
  if (!entry) return true;
  return entry.status === "verified";
}
