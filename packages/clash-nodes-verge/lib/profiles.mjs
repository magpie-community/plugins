// Read every subscription Clash Party keeps, not only the active one, and
// merge their `proxies:` lists into one catalogue our own mihomo instance can
// serve. Profile YAML is subscription output: either block style
//
//   proxies:
//     - name: 香港01
//       type: hysteria2
//
// or flow style (common for remote subscriptions):
//
//   proxies:
//     - { name: '香港01', type: hysteria2, server: ..., port: 40001 }
//
// We only need each item's raw text and its name/type, then rewrite the name
// with a per-subscription prefix so two airports may both have "香港01".
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isAdNode, regionOf } from './nodes.mjs';

/**
 * Clash Verge Rev stores its profiles in
 *   %APPDATA%\io.github.clash-verge-rev.clash-verge-rev\profiles.yaml
 * as `- uid:` items, while mihomo-party uses `profile.yaml` with `- id:`.
 * Both are supported; the first directory that actually has an index wins.
 */
export function clashRoot() {
  const cands = [
    process.env.CLASH_VERGE_DIR,
    path.join(os.homedir(), 'AppData', 'Roaming', 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(os.homedir(), '.config', 'clash-verge'),
    process.env.MIHOMO_PARTY_DIR,
    path.join(os.homedir(), 'AppData', 'Roaming', 'mihomo-party'),
    path.join(os.homedir(), '.config', 'mihomo'),
  ].filter(Boolean);
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'profiles.yaml')) || fs.existsSync(path.join(d, 'profile.yaml'))) return d;
  }
  return cands[0];
}
export function mihomoPartyDir() { return clashRoot(); }
export function profilesDir() { return path.join(clashRoot(), 'profiles'); }
export function profileIndexPath() {
  const root = clashRoot();
  const verge = path.join(root, 'profiles.yaml');
  return fs.existsSync(verge) ? verge : path.join(root, 'profile.yaml');
}

function readIndex() {
  try { return fs.readFileSync(profileIndexPath(), 'utf8'); } catch { return ''; }
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return { exists: true, updatedAt: st.mtimeMs };
  } catch { /* missing */ }
  return { exists: false, updatedAt: 0 };
}

function indexItem(file, extra) {
  const st = statFile(file);
  return st.exists ? { file, updatedAt: st.updatedAt, ...extra } : null;
}

/** Clash Verge: `- uid:` items; only profiles that can carry proxies. */
function vergeItems(text) {
  const current = (text.match(/^current:\s*(\S+)/m) || [])[1] || '';
  const items = [];
  for (const block of text.split(/^(?=- uid:)/m)) {
    const id = (block.match(/^- uid:\s*(\S+)/m) || [])[1];
    if (!id) continue;
    const type = ((block.match(/^\s+type:\s*(\S+)/m) || [])[1] || '').trim();
    if (type && !/^(remote|proxies|merge)$/.test(type)) continue;
    const rawName = unquote(((block.match(/^\s+name:\s*([^\r\n]+)/m) || [])[1] || '').trim());
    const name = rawName === 'null' ? '' : rawName;
    const url = unquote(((block.match(/^\s+url:\s*([^\r\n]+)/m) || [])[1] || '').trim());
    let urlHost = '';
    try { urlHost = url ? new URL(url).host : ''; } catch { /* not a URL */ }
    const rel = unquote(((block.match(/^\s+file:\s*([^\r\n]+)/m) || [])[1] || `${id}.yaml`).trim());
    const item = indexItem(path.join(profilesDir(), rel), {
      id, type, name, urlHost, active: id === current,
    });
    if (!item) continue;
    // Merge / proxies templates are only interesting when they actually add nodes.
    if (type !== 'remote' && countProxies(item.file) === 0) continue;
    items.push(item);
  }
  return items;
}

/** mihomo-party: `- id:` followed by `name:`. */
function partyItems(text) {
  const current = (text.match(/^current:\s*(\S+)/m) || [])[1] || '';
  const items = [];
  const re = /^\s*-\s+id:\s*(\S+)\s*\r?\n\s*name:\s*([^\r\n]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1].trim();
    const name = unquote(m[2].trim());
    const item = indexItem(path.join(profilesDir(), `${id}.yaml`), {
      id, type: 'remote', name, active: id === current,
    });
    if (item) items.push(item);
  }
  return items;
}

function countProxies(file) {
  try { return extractProxies(fs.readFileSync(file, 'utf8')).length; } catch { return 0; }
}

/** Subscription list, in file order. */
export function listProfiles() {
  const text = readIndex();
  if (!text) return [];
  const verge = /profiles\.yaml$/i.test(profileIndexPath());
  const items = verge ? vergeItems(text) : partyItems(text);
  // disambiguate duplicate subscription names (two "一元机场")
  const seen = {};
  for (const p of items) {
    // Verge sometimes stores only a UUID / hash as the profile name; the
    // subscription host reads better and stays stable across updates.
    const base = (!p.name || /^[0-9a-f][0-9a-f-]{20,}$/i.test(p.name)) && p.urlHost
      ? p.urlHost
      : (p.name || p.id);
    seen[base] = (seen[base] || 0) + 1;
    p.label = seen[base] > 1 ? `${base} (${seen[base]})` : base;
  }
  return items;
}

/** Split the raw `proxies:` section into one string per list item. */
export function extractProxies(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  if (start < 0) return [];
  const items = [];
  let cur = null;
  let curIndent = '';
  const push = () => { if (cur !== null) { items.push(cur); cur = null; } };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;      // next top-level key
    if (!line.trim()) { if (cur !== null) cur += '\n' + line; continue; }
    const item = line.match(/^(\s*)-\s+/);
    if (item) {
      // a new item starts at the list's own indent, not a nested list
      if (cur === null || item[1].length <= curIndent.length) {
        push();
        curIndent = item[1];
        cur = line;
        continue;
      }
    }
    if (cur !== null) cur += '\n' + line;
  }
  push();
  // flow items are one line; strip trailing blanks
  return items.map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim());
}

function unquote(s) {
  s = String(s || '').trim();
  // Clash Verge writes names that contained quotes as `\"name\` — escaped but
  // unbalanced, so neither the single- nor double-quote branch below applies.
  const vergeEscaped = s.match(/^\\+"([\s\S]*?)\\+"?$/);
  if (vergeEscaped) return vergeEscaped[1];
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}
function quoteYaml(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/**
 * Block-style items do not necessarily start with `name:` (Clash Verge
 * subscriptions commonly begin with `- client-fingerprint: …`), so look for
 * the field at the item's own property column instead of the first line.
 */
function blockBody(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const first = lines[0] || '';
  const dash = first.match(/^(\s*)-\s+/);
  if (!dash) return { lines, col: -1 };
  const col = dash[0].length;
  lines[0] = ' '.repeat(col) + first.slice(col);
  return { lines, col, prefix: dash[1] + '- ' };
}

function blockField(raw, key) {
  const { lines, col, prefix } = blockBody(raw);
  if (col < 0) return null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m || m[1].length !== col) continue;
    if (m[2] !== key) continue;
    return { value: m[3].trim(), col, prefix, index: i };
  }
  return null;
}

/** name/type of one raw item, flow or block style. */
export function proxyMeta(raw) {
  const first = raw.split(/\r?\n/)[0];
  const flow = /^\s*-\s*\{/.test(first);
  if (flow) {
    const nameM = first.match(/\bname:\s*'((?:[^']|'')*)'/) ||
      first.match(/\bname:\s*"([^"]*)"/) ||
      first.match(/\bname:\s*([^,}]+)/);
    const typeM = first.match(/\btype:\s*([^,}\s]+)/);
    return {
      flow,
      name: unquote(nameM ? (nameM[1] || nameM[2] || nameM[3] || '') : ''),
      type: typeM ? unquote(typeM[1]) : '',
    };
  }
  const nameF = blockField(raw, 'name');
  const typeF = blockField(raw, 'type');
  return {
    flow,
    name: unquote(nameF ? nameF.value : ''),
    type: unquote(typeF ? typeF.value.split(/\s+#/)[0] : ''),
  };
}

/** Rewrite the item's name in place. */
export function renameProxy(raw, newName) {
  const first = raw.split(/\r?\n/)[0];
  if (/^\s*-\s*\{/.test(first)) {
    const replaced = first.replace(/(\bname:\s*)(?:'(?:[^']|'')*'|"[^"]*"|[^,}]+)/, `$1${quoteYaml(newName)}`);
    return [replaced, ...raw.split(/\r?\n/).slice(1)].join('\n');
  }
  const field = blockField(raw, 'name');
  if (!field) return raw;
  const lines = raw.split(/\r?\n/);
  const lead = field.index === 0 ? field.prefix : ' '.repeat(field.col);
  lines[field.index] = `${lead}name: ${quoteYaml(newName)}`;
  return lines.join('\n');
}

/**
 * Normalize one raw list item to exactly two spaces of indentation under
 * `proxies:`. Different airports indent their list items differently (0/2/4
 * spaces); concatenating raw blocks from several profiles then produces
 * invalid YAML such as `- {…}\n    - {…}`. Nested lines keep their relative
 * indentation to the item marker.
 */
export function normalizeProxyBlock(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (!lines.length || !lines[0].trim()) return '';
  const indentOf = (line) => (line.match(/^\s*/) || [''])[0].length;
  const base = indentOf(lines[0]);
  return lines.map((line, i) => {
    if (!line.trim()) return '';
    if (i === 0) return '  ' + line.trimStart();
    const extra = Math.max(0, indentOf(line) - base);
    return '  ' + ' '.repeat(extra) + line.trimStart();
  }).join('\n');
}

/**
 * One subscription's usable nodes.
 * Returns [{ name (prefixed), originalName, type, region, profileId, profileName, raw }]
 */
export function profileNodes(profile) {
  let text = '';
  try { text = fs.readFileSync(profile.file, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const raw of extractProxies(text)) {
    const meta = proxyMeta(raw);
    if (!meta.name || !meta.type) continue;
    if (isAdNode(meta.name)) continue;
    const name = `${profile.label} · ${meta.name}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      originalName: meta.name,
      type: meta.type,
      region: regionOf(meta.name),
      profileId: profile.id,
      profileName: profile.label,
      raw: normalizeProxyBlock(renameProxy(raw, name)),
    });
  }
  return out;
}

/** Merge selected subscriptions. `ids` empty = all. */
export function loadCatalogue(ids = []) {
  const all = listProfiles();
  const chosen = ids.length ? all.filter((p) => ids.includes(p.id)) : all;
  const chosenIds = new Set(chosen.map((p) => p.id));
  const nodes = [];
  const blocks = [];
  const counts = {};
  for (const p of all) {
    const list = profileNodes(p);
    counts[p.id] = list.length;
    if (!chosenIds.has(p.id)) continue;
    for (const n of list) {
      nodes.push(n);
      blocks.push(n.raw);
    }
  }
  nodes.sort((a, b) =>
    a.profileName.localeCompare(b.profileName, 'zh') ||
    a.region.localeCompare(b.region, 'zh') ||
    a.name.localeCompare(b.name, 'zh'));
  return { profiles: all, chosen: chosen.map((p) => p.id), nodes, blocks, counts };
}
