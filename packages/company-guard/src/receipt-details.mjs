// Viewer-only mapping. Never serialized to disk, sent upstream or used to mask
// another request. Keeping this optional view must not change request behavior.
const entries = new Map();
const ttl = 30 * 60 * 1000, maxEntries = 25, maxBytes = 2 * 1024 * 1024;
let used = 0;
function remove(key) {
  const entry = entries.get(key); if (!entry) return;
  clearTimeout(entry.timer); used -= entry.bytes; entries.delete(key);
}
export function rememberDetails(root, receipt, reverse) {
  try {
    const pairs = Object.entries(reverse || {}).map(([token, original]) => ({original, token}));
    const bytes = pairs.reduce((n,p) => n + 2 * (p.original.length + p.token.length), 0);
    if (bytes > maxBytes) return;
    const key = root + "\0" + receipt.id;
    remove(key);
    while (entries.size && (entries.size >= maxEntries || used + bytes > maxBytes)) remove(entries.keys().next().value);
    const entry = {task:receipt.task, thread:receipt.thread, pairs, bytes, expiresAt:Date.now()+ttl};
    entry.timer = setTimeout(() => remove(key),ttl); entry.timer.unref();
    entries.set(key,entry); used += bytes;
  } catch { /* The view is optional; never interrupt masking. */ }
}
export function readDetails(root, id) {
  const key=root + "\0" + id, entry=entries.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {remove(key);return {available:false};}
  return {available:true, task:entry.task, thread:entry.thread, pairs:entry.pairs, expiresAt:entry.expiresAt};
}

export function retainDetails(root, ids) {
  const prefix = root + "\0";
  for (const key of entries.keys()) if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) remove(key);
}
