// fix-tool-args.middleware.js — magpie gateway middleware
//
// Repairs tool-call arguments a vendor streams as invalid JSON, before the
// agent client parses them. A model that drops the quotes around a string
// value — e.g. xfyun spark-x2.6 streaming {"pattern":**/*fd86512e*} — dies
// in a strict client (pi-ai / DeepSeek Harness) with MALFORMED_RESPONSE and
// the whole turn is lost.
//
// Semantics (magpie internal/middleware/run.go, verified): onEvent receives
// the parsed JSON of one SSE data line. Return undefined to leave the event
// byte-for-byte as it was; return an object to replace the data line;
// return null to drop it. ctx.state is shared by the request's hooks. A
// throwing hook is logged and its input passes as it was (fail-open), so
// every path below also try/catches.
//
// What it does on an OpenAI chat stream:
//   - chunks whose delta carries tool_calls argument fragments are held in
//     ctx.state (per tool index; id/name kept from the first fragment);
//   - every other chunk passes through untouched;
//   - when the chunk carrying finish_reason arrives, all held fragments are
//     joined and parsed. Valid JSON is emitted as it was joined. Invalid
//     JSON goes through a conservative repair (bare keys and bare values
//     get quoted; trailing commas dropped; raw control chars inside strings
//     escaped) and the repaired form is emitted with the ORIGINAL
//     finish_reason preserved. If even the repaired form is not an object,
//     the fragments are emitted as they came — the client sees the same
//     failure it would have seen without this middleware, never a lie;
//   - a stream cut before finish_reason leaves the fragments held (the
//     client loses a partial call it could not have parsed anyway).
//
// One emitted chunk carries every held call in its delta.tool_calls array;
// clients merge fragments by index, so one whole-argument fragment per
// call is exactly what a well-behaved vendor would have sent.
//
// mode option: "repair" (default) repairs; "off" passes everything.

export function onEvent(ev, ctx) {
  try {
    if (ctx.options && ctx.options.mode === 'off') return;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
    const choices = ev.choices;
    if (!Array.isArray(choices)) return;

    let holdSeen = false;
    let finishSeen = false;
    for (const ch of choices) {
      if (!ch || !ch.delta) continue;
      const calls = ch.delta.tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          holdFragment(ctx, tc);
          holdSeen = true;
        }
      }
      if (typeof ch.finish_reason === 'string' && ch.finish_reason !== '') {
        finishSeen = true;
      }
    }

    if (holdSeen && !finishSeen) return null;      // hold: drop the event
    if (!finishSeen) return;                        // nothing of ours

    // The finish chunk: flush every held call, repaired, in one chunk.
    const order = (ctx.state && ctx.state.holdOrder) || [];
    const held = [];
    for (const idx of order) {
      const h = ctx.state.hold[idx];
      if (h) held.push(h);
    }
    ctx.state.hold = {};
    ctx.state.holdOrder = [];
    if (held.length === 0) return;                  // finish without calls

    const calls = [];
    for (const h of held) {
      calls.push({
        index: h.index,
        id: h.id,
        type: 'function',
        function: { name: h.name, arguments: repairedArgs(h.frags.join('')) },
      });
    }

    // Rebuild the finish chunk: the first choice keeps its finish_reason
    // (and any content it carried) and now carries the whole calls at once.
    const first = choices[0] || {};
    const delta = {};
    if (first.delta && typeof first.delta.content === 'string') {
      delta.content = first.delta.content;
    }
    delta.tool_calls = calls;
    const out = {};
    for (const k in ev) {
      if (k !== 'choices') out[k] = ev[k];
    }
    out.choices = [{ index: first.index || 0, delta: delta, finish_reason: first.finish_reason }];
    for (let i = 1; i < choices.length; i++) out.choices.push(choices[i]);
    return out;
  } catch (_) {
    return ev; // fail-open
  }
}

function holdFragment(ctx, tc) {
  if (!tc || typeof tc !== 'object') return;
  const st = ctx.state;
  if (!st.hold) { st.hold = {}; st.holdOrder = []; }
  const idx = typeof tc.index === 'number' ? tc.index : st.holdOrder.length;
  let h = st.hold[idx];
  if (!h) {
    h = { index: idx, id: '', name: '', frags: [] };
    st.hold[idx] = h;
    st.holdOrder.push(idx);
  }
  if (!h.id && typeof tc.id === 'string' && tc.id) h.id = tc.id;
  if (!h.name && tc.function && typeof tc.function.name === 'string' && tc.function.name) {
    h.name = tc.function.name;
  }
  const a = tc.function && tc.function.arguments;
  if (typeof a === 'string' && a.length > 0) h.frags.push(a);
}

// repairedArgs returns the arguments string to emit: the join when it
// parses, else the repair when the repair parses, else the join as it came.
function repairedArgs(args) {
  if (!args || !args.trim()) return '{}';
  if (parsesAsObject(args)) return args;
  const r = repairJsonLoose(args);
  if (parsesAsObject(r)) return r;
  return args;
}

function parsesAsObject(s) {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch (_) { return false; }
}

// repairJsonLoose rewrites only what it can prove is broken. One pass,
// outside strings:
//   - a bare KEY (a run in an object's key slot that a ':' follows) is
//     quoted;
//   - a bare VALUE (a run in a value slot that starts like no JSON value)
//     is quoted up to the next structural character — internal spaces and
//     colons belong to it (a dropped-quote path like C:/x y, a glob, a
//     shell command). A `,` or closing bracket still ends the value: the
//     run cannot be told apart from the next member's, so a command that
//     needs one (ls a, b) stays broken;
//   - a ',' directly before } or ] is dropped (trailing comma);
//   - a raw control character inside a string is escaped (the same fix
//     pi-ai's own repairJson applies client-side).
// An empty run invents nothing, and whatever comes out is parsed before
// use: genuinely broken input stays broken and is handed over unchanged.
function repairJsonLoose(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let inStr = false;
  const stack = []; // '{' or '['
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const structural = ',}][{';
  const valueStart = (c) =>
    c === '"' || c === '{' || c === '[' ||
    c === 't' || c === 'f' || c === 'n' || c === '-' || (c >= '0' && c <= '9');
  while (i < n) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { inStr = false; out += c; i++; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        out += '\\u' + ('000' + code.toString(16)).slice(-4);
        i++;
        continue;
      }
      out += c; i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '{' || c === '[') { stack.push(c); out += c; i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); out += c; i++; continue; }
    if (c === ':') { out += c; i++; continue; }
    if (c === ',') {
      let k = i + 1;
      while (k < n && isWs(s[k])) k++;
      if (k < n && (s[k] === '}' || s[k] === ']')) { i++; continue; } // trailing comma
      out += c;
      i++;
      continue;
    }
    // A bare run may begin here. Which slot it sits in decides where it
    // ends: a key slot (an object, right after { or ,) ends at whitespace
    // or ':'; a value slot (after :, or anywhere in an array) ends at
    // , } ] { [ and keeps its internal whitespace — a shell command or a
    // Windows path with spaces is the common dropped-quote case.
    let p = out.length;
    while (p > 0 && isWs(out[p - 1])) p--;
    const prev = p > 0 ? out[p - 1] : '';
    const top = stack.length > 0 ? stack[stack.length - 1] : '';
    const keySlot = top === '{' && (prev === '{' || prev === ',');
    const valueSlot = prev === ':' || prev === '[' || (prev === ',' && top === '[');
    if (keySlot || valueSlot) {
      if (!valueStart(c)) {
        let j = i;
        while (j < n && structural.indexOf(s[j]) < 0 &&
               !(keySlot && (isWs(s[j]) || s[j] === ':'))) j++;
        if (keySlot) {
          let k = j;
          while (k < n && isWs(s[k])) k++;
          if (k < n && s[k] === ':') {
            out += JSON.stringify(s.slice(i, j)); // bare key
            i = j;
            continue;
          }
        }
        let e = j;
        while (e > i && isWs(s[e - 1])) e--;
        if (e > i) {                              // bare value (or a best
          out += JSON.stringify(s.slice(i, e));   // effort quote for a key
          out += s.slice(e, j);                   // whose ':' never came)
          i = j;
          continue;
        }
      }
    }
    out += c; i++;
  }
  return out;
}
