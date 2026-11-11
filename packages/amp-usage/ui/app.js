const $ = (id) => document.getElementById(id);
const theme = new URL(location.href).searchParams.get("theme");
document.documentElement.dataset.theme =
  theme === "dark" ||
  (!theme && matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
const token = document.querySelector('meta[name="service-token"]').content;
let state,
  busy = false;
const descriptions = {
  identityChanged:
    "Usage matches an imported record under a different ID; held for review",
  missingTimestamp: "Missing reliable timestamps; excluded from daily history",
  unfinished: "Still streaming or not completed; excluded",
  settling: "Recently updated usage; waiting",
  invalidUsage: "Invalid model or token fields; excluded",
  conflictingIdentity: "Conflicting records with the same message ID; excluded",
  changedAfterImport:
    "Previously imported records changed; preserved without adding them again",
  gatewayDuplicate: "Already recorded by the Magpie gateway; excluded",
  excludedThread: "Threads excluded in plugin options",
  excludedModel: "Models excluded in plugin options or marked as Magpie-routed",
};
async function api(path, body) {
  const r = await fetch(new URL(`api/${path}`, location.href), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Amp-Usage-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(result.error || `Service returned HTTP ${r.status}`);
  return result;
}
function errors(messages) {
  $("errors").replaceChildren(
    ...messages.map((m) => {
      const p = document.createElement("p");
      p.textContent = m;
      return p;
    }),
  );
  $("errors").hidden = !messages.length;
}
function render(s) {
  state = s;
  const working = s.phase !== "idle";
  $("mode-status").textContent = working
    ? "Scanning"
    : s.settings.enabled
      ? "Collection enabled"
      : "Paused";
  $("source").value = s.settings.mode;
  $("source-help").textContent =
    s.settings.mode === "cloud"
      ? "Uses your existing Amp sign-in. Only usage metadata is kept; prompts and tool output are not saved."
      : `Reads old thread files on this computer: ${s.threadDirs.join(", ")}. Current cloud threads require the CLI source.`;
  for (const id of ["source", "scan", "toggle", "sync"])
    $(id).disabled = working || busy;
  $("toggle").textContent = s.settings.enabled
    ? "Pause collection"
    : "Enable collection";
  $("sync").hidden = !s.settings.enabled;
  $("schedule").textContent = s.settings.enabled
    ? `Syncs every ${s.intervalSeconds / 60} minutes while Magpie is running. Records must stay unchanged for ${s.settleSeconds} seconds across scans.`
    : "Collection starts paused. Preview first; enabling it writes records to Magpie's history.";
  $("results").setAttribute("aria-busy", String(working));
  $("counts").hidden = !s.lastScan;
  $("empty").hidden = !!s.lastScan;
  $("last-scan").textContent = s.lastScan
    ? new Date(s.lastScan).toLocaleString()
    : "No scan yet";
  for (const [id, k] of Object.entries({
    threads: "scannedThreads",
    ready: "eligible",
    pending: "pending",
    imported: "imported",
    skipped: "skipped",
    total: "totalImported",
    remaining: "remaining",
  }))
    $(id).textContent = Number(s[k] || 0).toLocaleString();
  $("progress").textContent = working
    ? "Reading Amp usage. You can leave this page; collection runs in the background."
    : s.remaining
      ? "More cloud threads remain. Run another scan to continue the export."
      : s.pending
        ? "Usage is waiting to settle. Run another scan after the settling interval, or enable automatic collection."
        : s.lastScan &&
            !s.eligible &&
            !s.totalImported &&
            !Object.keys(s.issues).length
          ? "No eligible usage found in this source."
          : "";
  const items = Object.entries(s.issues || {})
    .filter(([, n]) => n)
    .map(([k, n]) => {
      const li = document.createElement("li");
      li.textContent = `${descriptions[k] || k}: ${n.toLocaleString()}`;
      return li;
    });
  $("issues").replaceChildren(...items);
  $("issues-box").hidden = !items.length;
  errors(s.errors || []);
  $("destination").textContent = `Destination: ${s.gatewayURL}`;
}
async function act(fn) {
  if (busy) return;
  busy = true;
  if (state) render(state);
  try {
    const s = await fn();
    busy = false;
    render(s);
  } catch (e) {
    busy = false;
    if (state) render(state);
    errors([e.message]);
  }
}
$("scan").onclick = () => act(() => api("scan", {}));
$("sync").onclick = () => act(() => api("sync", {}));
$("toggle").onclick = () =>
  act(async () => {
    const next = await api("settings", {
      ...state.settings,
      enabled: !state.settings.enabled,
    });
    return next.settings.enabled ? api("sync", {}) : next;
  });
$("source").onchange = () => {
  const mode = $("source").value;
  return act(() => api("settings", { enabled: false, mode }));
};
async function poll() {
  if (!busy) {
    try {
      render(await api("status"));
    } catch (e) {
      errors([e.message]);
    }
  }
}
void poll();
setInterval(poll, 2000);
