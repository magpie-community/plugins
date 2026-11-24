// @magpie-community/middleware-incognito — makes any AI agent incognito to
// model upstreams.
//
// Some model upstreams fingerprint the requests of specific AI agents and
// reject them in disguise — a coding agent whose system prompt says
// "You are an AI agent powered by DeepSeek Harness." got thrown into a
// queue that never clears (surfacing as hangs), and one saying
// "You are Claude Code, Anthropic's official CLI for Claude." got a fake
// `400 Cannot find model`. Bare words are fine; only exact identity
// sentences trip. New agents appear every month, and chasing exact
// strings is whack-a-mole — so this middleware targets the *shape*:
//
//   1. Identity-sentence hardening (shape-level, zero semantic change)
//        You are <Name>, <description>.          → You are <Name> (<description>).
//        You are ... powered by <Brand>.         → You are ... (powered by <Brand>).
//      Pure punctuation: the upstream's exact-match fingerprints stop
//      matching, the model reads the same thing. Applied to the first
//      identity sentence of every system/instructions text block, on all
//      three gateway paths (/v1/chat/completions, /v1/messages,
//      /v1/responses — the onRequest hook fires on all of them).
//   2. Exact poison rewriting (belt and suspenders): a small rule table of
//      known-bad sentences, scanned across every string of the request —
//      messages, system, instructions, input, tools — including what the
//      user types. Extend via the `rules` option from the magpie UI.
//   3. Model-name normalization: a trailing [1M]/[1m] context-window
//      marker on body.model (Claude Code does this) is stripped before it
//      reaches upstreams that answer `unknown or disabled model`.
//
// Rules that don't match leave the request byte-identical; nothing is
// added, nothing is phoned home. Options (all optional, set them in
// magpie's plugin options):
//   {
//     "harden_identity": true,     // shape-level rewriting (default on)
//     "strip_model_suffix": true,  // strip trailing [1M]/[1m] (default on)
//     "rules": [                   // extra exact rules, merged after built-ins
//       { "from": "some poison sentence", "to": "a harmless one" }
//     ]
//   }
//
// magpie middleware sandboxes: no imports of node builtins, no fetch —
// everything below is plain synchronous JavaScript on purpose.

// Exact rules known to trip upstreams as of 2026-11. Safe no-ops on
// upstreams that never see these strings. `powered by Agent Harness`
// reads the same to the model; upstream exact-matchers stop matching.
const BUILTIN_RULES = [
  { from: 'You are an AI agent powered by DeepSeek Harness.', to: 'You are an AI agent powered by Agent Harness.' },
  { from: 'DeepSeek Harness', to: 'Agent Harness' },
  { from: 'You are Claude Code,', to: 'You are Claude Code (' },
];

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileRules(extra) {
  const all = extra && Array.isArray(extra) ? BUILTIN_RULES.concat(extra) : BUILTIN_RULES;
  return all
    .filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string')
    .map((r) => ({ re: new RegExp(ESC(r.from), 'g'), to: r.to }));
}

function fixText(text, rules) {
  let changed = false;
  for (const { re, to } of rules) {
    if (re.test(text)) {
      text = text.replace(re, to);
      changed = true;
    }
  }
  return { text, changed };
}

// ---- shape-level identity hardening (pure punctuation) ----

function deFingerprintSentence(sentence) {
  // You are <Name>, <description>. → You are <Name> (<description>).
  let m = sentence.match(/^You are ([A-Z][^,.;\n]{0,48}),\s*(.{2,200}?)([.\n]|$)/);
  if (m) return `You are ${m[1]} (${m[2]})${m[3]}`;
  // You are ... powered by <Brand>. → You are ... (powered by <Brand>).
  m = sentence.match(/^(You are [^.\n]{0,160}?)\s+powered by ([A-Za-z][\w .&'-]{0,48}?)([.\n]|$)/);
  if (m) return `${m[1]} (powered by ${m[2]})${m[3]}`;
  return sentence;
}

// only the first "You are ..." sentence of a text — where identity lines live
function hardenIdentity(text) {
  if (typeof text !== 'string') return { text, changed: false };
  const m = text.match(/You are [A-Za-z][^.\n]{0,200}?([.\n]|$)/);
  if (!m) return { text, changed: false };
  const hardened = deFingerprintSentence(m[0]);
  if (hardened === m[0]) return { text, changed: false };
  return { text: text.replace(m[0], hardened), changed: true };
}

function hardenIdentityContent(content) {
  if (typeof content === 'string') {
    const r = hardenIdentity(content);
    return { content: r.text, changed: r.changed };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part) => {
      if (part && typeof part.text === 'string') {
        const r = hardenIdentity(part.text);
        if (r.changed) changed = true;
        return { ...part, text: r.text };
      }
      return part;
    });
    return { content: parts, changed };
  }
  return { content, changed: false };
}

// ---- deep scan: apply exact rules to every string of any JSON value ----

function deepScan(value, rules) {
  if (typeof value === 'string') {
    const r = fixText(value, rules);
    return r.changed ? { value: r.text, changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((x) => {
      const r = deepScan(x, rules);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const r = deepScan(value[k], rules);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  return { value, changed: false };
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== 'object') return;
  const o = (ctx && ctx.options) || {};
  const rules = compileRules(o.rules);
  const harden = o.harden_identity !== false;
  const stripSuffix = o.strip_model_suffix !== false;
  let changed = false;

  // 0) model-name normalization: trailing [1M]/[1m] context markers
  if (stripSuffix && typeof body.model === 'string') {
    const fixedModel = body.model.replace(/\[1m\]$/i, '');
    if (fixedModel !== body.model) {
      body.model = fixedModel;
      changed = true;
    }
  }

  // 1) shape-level identity hardening, where identity lines live:
  //    Anthropic-style top-level system, Responses-style instructions,
  //    and system-role messages (chat-completions / messages paths)
  if (harden) {
    if (body.system !== undefined && body.system !== null) {
      const r = hardenIdentityContent(body.system);
      if (r.changed) {
        body.system = r.content;
        changed = true;
      }
    }
    if (typeof body.instructions === 'string') {
      const r = hardenIdentity(body.instructions);
      if (r.changed) {
        body.instructions = r.text;
        changed = true;
      }
    }
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m || m.role !== 'system') continue;
        const r = hardenIdentityContent(m.content);
        if (r.changed) {
          m.content = r.content;
          changed = true;
        }
      }
    }
  }

  // 2) exact poison rules, deep-scanned everywhere
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const r = deepScan(m.content, rules);
      if (r.changed) changed = true;
      return r.changed ? { ...m, content: r.value } : m;
    });
  }
  for (const k of ['system', 'instructions', 'input']) {
    if (body[k] !== undefined && body[k] !== null) {
      const r = deepScan(body[k], rules);
      if (r.changed) {
        body[k] = r.value;
        changed = true;
      }
    }
  }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const target = t.function && typeof t.function === 'object' ? t.function : t;
      const r = deepScan(target, rules);
      if (!r.changed) return t;
      changed = true;
      return target === t ? r.value : { ...t, function: r.value };
    });
  }

  if (changed) return body;
}
