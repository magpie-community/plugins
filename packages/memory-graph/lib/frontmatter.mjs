// YAML frontmatter parser for magpie memory markdown files.
//
// Avoids third-party YAML dependencies: magpie only emits a fixed subset of YAML
// (scalars, inline arrays, block sequences, map lists in sources, and block scalars).
// Parse failures never throw; a single memory degrades to body + empty metadata
// so one malformed file cannot break the entire graph.

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const KINDS = new Set([
  "profile",
  "preference",
  "rule",
  "reference",
  "fact",
  "procedure",
  "episode",
  "unknown",
]);

const STATUSES = new Set(["active", "candidate", "superseded", "archived"]);

function splitFrontmatter(raw) {
  const text = String(raw ?? "");
  const hit = FRONTMATTER.exec(text);
  if (!hit) return { yaml: "", body: text };
  return { yaml: hit[1] || "", body: text.slice(hit[0].length) };
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

function unquote(raw) {
  const text = String(raw ?? "").trim();
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseInlineArray(raw) {
  const inner = String(raw ?? "").trim().slice(1, -1);
  if (!inner.trim()) return [];
  const out = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      const value = unquote(current);
      if (value !== "") out.push(value);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = unquote(current);
  if (last !== "") out.push(last);
  return out;
}

function scalar(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[") && text.endsWith("]")) return parseInlineArray(text);
  return unquote(text);
}

function blockIndicator(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "|" || trimmed === "|-") return "|";
  if (trimmed === ">" || trimmed === ">-") return ">";
  return "";
}

function foldBlock(lines, style) {
  const body = trimBlank(lines);
  if (!body.length) return "";
  const indents = body
    .filter((line) => line.trim())
    .map((line) => (line.match(/^[ \t]*/) || [""])[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  const text = body.map((line) => line.slice(cut)).join("\n");
  if (style === ">") {
    return text
      .split(/\n{2,}/)
      .map((part) => part.replace(/\n/g, " ").trim())
      .join("\n\n")
      .trim();
  }
  return text.replace(/\n+$/, "");
}

function indentOf(line) {
  return (line.match(/^[ \t]*/) || [""])[0].length;
}

function collectIndentedBlock(lines, startIndex, minIndentExclusive) {
  const block = [];
  let j = startIndex;
  while (j < lines.length) {
    const next = lines[j];
    if (!next.trim()) {
      block.push(next);
      j++;
      continue;
    }
    if (indentOf(next) <= minIndentExclusive) break;
    block.push(next);
    j++;
  }
  return { block, nextIndex: j };
}

function collectListItemBlock(lines, startIndex, listIndent, keyIndent) {
  const block = [];
  let j = startIndex;
  while (j < lines.length && (/^[ \t]/.test(lines[j]) || !lines[j].trim())) {
    const next = lines[j];
    if (next.trim()) {
      const nextIndent = indentOf(next);
      if (/^[ \t]*-[ \t]?/.test(next) && nextIndent <= listIndent + 1) break;
      if (nextIndent <= keyIndent && /^[ \t]*[A-Za-z_][\w-]*:[ \t]*/.test(next)) break;
      if (nextIndent <= listIndent) break;
    }
    block.push(next);
    j++;
  }
  return { block, nextIndex: j };
}

function parseMap(lines, indent) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const hit = /^[ \t]*([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!hit) continue;
    const key = hit[1];
    const value = hit[2];

    const style = blockIndicator(value);
    if (style) {
      const { block, nextIndex } = collectIndentedBlock(lines, i + 1, indent);
      out[key] = foldBlock(block, style);
      i = nextIndex - 1;
      continue;
    }

    if (!value.trim()) {
      const { block, nextIndex } = collectIndentedBlock(lines, i + 1, indent);
      out[key] = parseBlock(block);
      i = nextIndex - 1;
      continue;
    }

    out[key] = scalar(value);
  }
  return out;
}

function parseList(lines, indent) {
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const item = /^[ \t]*-[ \t]?(.*)$/.exec(line);
    const lineIndent = indentOf(line);

    if (item && lineIndent <= indent + 1) {
      if (current !== null) items.push(current);
      const rest = item[1];
      const pair = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(rest);
      if (pair) {
        const style = blockIndicator(pair[2]);
        current = { [pair[1]]: style ? "" : scalar(pair[2]) };
        if (style) {
          const itemIndent = line.length - rest.length;
          const { block, nextIndex } = collectListItemBlock(lines, i + 1, indent, itemIndent);
          current[pair[1]] = foldBlock(block, style);
          i = nextIndex - 1;
        }
      } else {
        current = scalar(rest);
      }
      continue;
    }

    if (current && typeof current === "object" && !Array.isArray(current)) {
      const pair = /^[ \t]*([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
      if (!pair) continue;
      const style = blockIndicator(pair[2]);
      if (style) {
        const { block, nextIndex } = collectListItemBlock(lines, i + 1, indent, lineIndent);
        current[pair[1]] = foldBlock(block, style);
        i = nextIndex - 1;
      } else {
        current[pair[1]] = scalar(pair[2]);
      }
    }
  }

  if (current !== null) items.push(current);
  return items;
}

function parseBlock(lines) {
  const body = trimBlank(lines);
  if (!body.length) return null;
  const first = body.find((line) => line.trim());
  if (!first) return null;
  const indent = indentOf(first);
  if (/^[ \t]*-[ \t]?/.test(first)) return parseList(body, indent);
  return parseMap(body, indent);
}

function parseYaml(yaml) {
  const lines = String(yaml ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const hit = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!hit) {
      i++;
      continue;
    }
    const key = hit[1];
    const value = hit[2];
    i++;

    const style = blockIndicator(value);
    if (style) {
      const block = [];
      while (i < lines.length && (/^[ \t]/.test(lines[i]) || !lines[i].trim())) {
        block.push(lines[i]);
        i++;
      }
      out[key] = foldBlock(block, style);
      continue;
    }

    if (value.trim()) {
      out[key] = scalar(value);
      continue;
    }

    const block = [];
    while (i < lines.length && (/^[ \t]/.test(lines[i]) || !lines[i].trim())) {
      block.push(lines[i]);
      i++;
    }
    out[key] = parseBlock(block);
  }

  return out;
}

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = text(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function parseMemory(id, raw) {
  const { yaml, body } = splitFrontmatter(raw);
  let meta = {};
  try {
    meta = parseYaml(yaml) || {};
  } catch {
    meta = {};
  }

  const kind = KINDS.has(text(meta.kind)) ? text(meta.kind) : "unknown";
  const status = STATUSES.has(text(meta.status)) ? text(meta.status) : "active";
  const tags = Array.isArray(meta.tags)
    ? unique(meta.tags.map((t) => text(t).slice(0, 64))).slice(0, 30)
    : [];
  const sources = Array.isArray(meta.sources)
    ? meta.sources
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .slice(0, 3)
        .map((item) => ({
          agent: text(item.agent).slice(0, 200),
          session: text(item.session).slice(0, 200),
          dir: text(item.dir).slice(0, 200),
          quote: text(item.quote).slice(0, 200),
        }))
    : [];

  const supersededBy = /^m_[0-9a-f]{12}$/.test(text(meta.supersededBy))
    ? text(meta.supersededBy)
    : null;

  return {
    id,
    kind,
    scope: text(meta.scope) || "global",
    status,
    origin: text(meta.origin),
    tags,
    why: text(meta.why).slice(0, 1000),
    created: text(meta.created),
    updated: text(meta.updated),
    supersededBy,
    sources,
    body: body.trim(),
  };
}

export function titleOf(body, why, id) {
  const first = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const clean = String(first || "")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean) return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
  const reason = String(why || "").replace(/\s+/g, " ").trim();
  if (reason) return reason.length > 40 ? `${reason.slice(0, 39)}…` : reason;
  return id;
}
