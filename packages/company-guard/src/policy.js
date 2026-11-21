import { sign, same } from "./crypto.js";

export const PROOF = "__nero_company_guard";
export const TASK_NAME_LIMIT = 65536;
export const TOKEN_PREFIX = "[[NERO_ORG_";
export function normalPrompt(s) { return typeof s === "string" ? s.replace(/\r\n/g, "\n").trim() : ""; }

export function directive(prompt) {
  const first = normalPrompt(prompt).split("\n", 1)[0];
  if (first.length > 600) return null;
  const m = /^(本轮允许原名|本次允许原名|本轮不脱敏|本次不脱敏|允许原名|不脱敏|联网核查|互联网核查|互联核查)\s*[:：]\s*(.+)$/.exec(first);
  if (!m) return null;
  const names = m[2].replace(/[。.]$/, "").split(/[；;、]/).map(s => s.trim());
  if (!names.length || names.length > 32 || names.some(s => !validName(s) || /^(所有|全部|任何|all|\*)$/i.test(s) || /[\n<>?？!！]/.test(s))) return null;
  return {mode: /核查$/.test(m[1]) ? "public_lookup" : "original", names: [...new Set(names)]};
}

export function identity(body) {
  const c = body && body.client_metadata;
  if (!c || typeof c !== "object") return null;
  let m = c["x-codex-turn-metadata"] || c;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch { return null; } }
  const ok = x => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(x);
  if (!m || !ok(m.thread_id) || !ok(m.turn_id) || m.thread_source !== "user") return null;
  return {thread: m.thread_id, turn: m.turn_id};
}

// The host supplies origin/session. Never recover ownership from prompt text.
export function taskSession(body, ctx) {
  if (!["local", "magpie-key"].includes(ctx?.origin) || ctx?.agent !== "codex" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(ctx?.session || "")) return null;
  const c = body?.client_metadata;
  let m = c?.["x-codex-turn-metadata"] || c;
  if (typeof m === "string") { try { m = JSON.parse(m); } catch { return null; } }
  if (m && typeof m !== "object") return null;
  // A human can explicitly authorize an existing chat created by an agent.
  // Its exact host session still needs a local task record and genuine user turn.
  if (m?.thread_source && !["user", "agent_created_thread"].includes(m.thread_source)) return null;
  if (m?.thread_id && m.thread_id !== ctx.session) return null;
  return ctx.session;
}

export function readProof(proof, body, key, ctx) {
  if (!proof || typeof proof.payload !== "string" || proof.payload.length > 2 * 1024 * 1024 || !same((ctx?.sign || sign)(key, proof.payload), proof.mac)) return null;
  let p; try { p = JSON.parse(proof.payload); } catch { return null; }
  if (p.v === 1 && proof.payload.length > 12000) return null;
  const id = identity(body), now = Date.now();
  if (!Number.isFinite(p.expires) || p.expires <= now || p.expires > now + 15000) return null;
  const session = taskSession(body, ctx);
  const task = p.v === 2 && p.scope === "session_task" && !!session && p.thread === session;
  if (!task && (!id || p.v !== 1 || p.thread !== id.thread || p.turn !== id.turn)) return null;
  if (!["original", "public_lookup"].includes(p.mode) || !Array.isArray(p.names) || p.names.length > (task ? TASK_NAME_LIMIT : 32) || p.names.some(n => !validName(n))) return null;
  return p;
}

export function validName(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 120 && !/^\s|\s$/.test(s) && /[A-Za-z\u00c0-\u024f\u3400-\u9fff]/.test(s) && !/[\x00-\x1f]/.test(s) && !s.includes(TOKEN_PREFIX);
}

export function configuredNames(options) {
  const out = [];
  for (const c of options.companies || []) {
    if (typeof c === "string") out.push(c);
    else if (c && typeof c === "object") { out.push(c.name); if (Array.isArray(c.aliases)) out.push(...c.aliases); }
  }
  if (out.length > 512 || out.some(n => !validName(n))) throw new Error("invalid_company_options");
  return [...new Set(out)];
}

export function expandAllowed(names, options) {
  const out = new Set(names);
  for (const c of options.companies || []) {
    if (!c || typeof c !== "object") continue;
    const group = [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])];
    if (group.some(n => out.has(n))) for (const n of group) if (validName(n)) out.add(n);
  }
  return out;
}

export function environmentText(s) {
  const t = s.trim();
  return t.startsWith("<environment_context>") || t.startsWith("<environment_info>") || t.startsWith("# AGENTS.md instructions for ");
}

// Exact tool names only. Generic execution is not evidence of a public source.
export function webTool(name) {
  return ["web.run", "web__run", "functions.web__run", "mcp__codex_apps__search_service__web_search", "mcp__codex_apps__search_service__search", "mcp__codex_apps__search_service__browse"].includes(name);
}

const LEGAL_NAME = /[\u3400-\u9fffA-Za-z0-9（(][\u3400-\u9fffA-Za-z0-9（）()·&．.\-]{1,79}?(?:股份有限公司|有限责任公司|有限公司|股份公司|集团公司)/;
// Fold suffix letters only; keep the existing capitalized-name start and bounds.
// Lowercase limited is also an adjective. Explicit name fields and configured
// names can still declare that spelling; ordinary prose retains a capital L.
const ENGLISH_KIND = /(?:Co\.,?[ \t]+Ltd\.?|Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|L\.L\.C\.|PLC|GmbH)/.source.replace(/\\.|Limited|[A-Za-z]/g, value => value === "Limited" ? "L[Ii][Mm][Ii][Tt][Ee][Dd]" : value.length === 1 ? `[${value.toUpperCase()}${value.toLowerCase()}]` : value);
const KIND_SUFFIX = /(?:股份有限公司|有限责任公司|有限公司|股份公司|集团公司|集团|公司)$/;
const GENERIC_PARTS = /(?:非上市|拟上市|非公众|供应商|交易对手|发行人|保荐人|可比|其他|任何|所有|全部|上述|相关|目标|项目|主体|企业|真实|实际|一般|普通|外部|内部|境内|境外|国内|国外|上市|公众|有限|股份|母子|集团|关联|同控|控股|参股|全资|被投|投资|持股|合作|客户|这家|那家|本|贵|该|各|某|母|子|孙)/g;
const FIELD_DESCRIPTION = /的(?:公司|集团)$|避免|当作|当成|没有|并非|不是|是否|能否|不能|不应|不要|只对|仅对|包含|保留|保护|替换|脱敏|识别|显示|看到|查看|核实|确认|表示|说明|继续|启动|存在|属于|涉及|上传|下载|配置|插件|页面|功能|工具|规则|名称|原名|本轮|本次|字段|提示词|样本|包括|以及|而非|等非|某个|某家|一家|一个|哪些|这些|这种|这类|用于|构成|均以|通过|提供的/;
const cleanName = name => name.replace(/^.*(?:映射最初包含|另查到|单独归入)/, "").replace(/^(?:(?:请帮我|帮我|请|查询|核查|分析|关于|公司名为|客户为|供应商为|交易对手为|以及|来自))+/, "");
const genericName = name => name.replace(KIND_SUFFIX, "").replace(GENERIC_PARTS, "") === "";

// Explicit name fields can carry short names. Generic roles and instructions
// are not names; configured names and aliases remain independent of this gate.
export function nameFieldValue(text, field = "") {
  if (typeof text !== "string") return null;
  const name = text.trim();
  if (!validName(name) || genericName(name)) return null;
  if (/^(?:unknown|none|null|n\/a|string|number|boolean|object|array)$/i.test(name)) return null;
  const full = LEGAL_NAME.exec(name);
  if (full && full[0] === name) return name;
  // Bare role keys also appear in code/table maps. Explicit name fields and
  // configured names may still declare a name with this spelling.
  if (/^(?:company|customer|supplier|counterparty)$/i.test(field) && /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return null;
  return FIELD_DESCRIPTION.test(name) ? null : name;
}

function recognitionText(text, quotes = false) {
  // Consume unmatched backslash runs too, so nested JSON stays linear to scan.
  return text.replace(/\\+(r\\+n|[nrt"])?/g, (raw, escaped) => !escaped ? raw : escaped === '"' ? (quotes ? '"' : raw) : "\n");
}

const LEGAL_HINT = /有限公司|有限责任公司|股份公司|集团公司/;
const ENGLISH_HINT = new RegExp("[ ,](?:"+ENGLISH_KIND+")\\b");
const FIELD_HINT = /company|customer|supplier|counterparty|entity_name|公司名称|客户名称|供应商名称|交易对手名称/i;

function scanLegalNames(text, visit) {
  const suffixes = ["股份有限公司","有限责任公司","有限公司","股份公司","集团公司"];
  const next = suffixes.map(s=>text.indexOf(s));
  const legal = new RegExp(LEGAL_NAME.source,"g");
  let after = 0;
  for (;;) {
    let k = -1;
    for (let i=0;i<next.length;i++) if (next[i]>=0 && (k<0 || next[i]<next[k])) k=i;
    if (k<0) return;
    const at = next[k], end = at+suffixes[k].length;
    next[k] = text.indexOf(suffixes[k],at+1);
    if (at<after) continue;
    // The existing rule admits at most 80 prefix characters. Run that exact
    // rule only beside an actual suffix, rather than retrying it at every
    // character in a long page or source-code result.
    const from = Math.max(after,at-80);
    legal.lastIndex = 0;
    const m = legal.exec(text.slice(from,end));
    if (!m) continue;
    m.index += from; after = m.index+m[0].length;
    for (let i=0;i<next.length;i++) if (next[i]>=0 && next[i]<after) next[i]=text.indexOf(suffixes[i],after);
    visit(m);
  }
}

export function detectNames(text) {
  const out = [];
  const add = s => { if (validName(s)) out.push(s); };
  const legalHint = LEGAL_HINT.test(text), englishHint = ENGLISH_HINT.test(text), fieldHint = FIELD_HINT.test(text);
  if (!legalHint && !englishHint && !fieldHint) return out;
  // Normalize escaped separators only in the recognition view. Original text,
  // numeric lexemes and the request's restoration map are never rewritten here.
  text = recognitionText(text);
  // Ordinary prose needs a legal company suffix. Bare 公司/集团 endings no
  // longer declare names; explicit fields and configured aliases still do.
  if (legalHint) scanLegalNames(text,m => {
    let name = cleanName(m[0]);
    // A quoted user definition can be followed by 与 + the contracting entity.
    // Do not strip 与 from a company name outside that grammatical context.
    if (name.startsWith("与") && /(?:用户|您|你|贵方)[”"」』]?[）)]$/.test(text.slice(Math.max(0, m.index - 24), m.index).trimEnd().replace(/\\+(?=")/g, ""))) name = name.slice(1);
    if (!genericName(name)) add(name);
  });
  const en = new RegExp(/\b[A-Z][A-Za-z0-9&.'’-]*(?:[ \t]+[A-Za-z0-9&.'’-]+){0,7}[ ,]+/.source + ENGLISH_KIND + /\b\.?/.source, "g");
  for (const m of englishHint ? text.matchAll(en) : []) {
    // A standard disclaimer phrase is not a company named Limited.
    if (!/\bBUT\s+NOT\s+LIMITED\.?$/i.test(m[0])) add(m[0]);
  }
  const fields = /(?:"(company(?:_name)?|customer(?:_name)?|supplier(?:_name)?|counterparty(?:_name)?|entity_name|公司名称|客户名称|供应商名称|交易对手名称)"\s*:\s*"((?:[^"\\]|\\.)*)"|(?:公司名称|客户名称|供应商名称|交易对手名称)[：:]\s*([^\n,，;；|\t]{2,120}))/gi;
  for (const m of fieldHint ? text.matchAll(fields) : []) {
    if (m[2] !== undefined) { try { const name = nameFieldValue(JSON.parse('"' + m[2] + '"'), m[1]); if (name) add(name); } catch { /* Malformed data cannot declare a name. */ } }
    else { const name = nameFieldValue(m[3]); if (name) add(name); }
  }
  return [...new Set(out)];
}

// Rebuild aliases from visible task material; no learned global dictionary.
// Definitions cannot change an original-name grant or another request's state.
export function taskAliases(slots) {
  const relations = new Map(), blocked = new Set();
  const generic = /^(?:我们|我方|对方|双方|各方|甲方|乙方|丙方|用户|您|你|本平台|本服务|本产品|本项目|本系统|平台|服务|产品|游戏|项目|系统|科技|电子|信息|中国|简称|全称|co|corp|inc|ltd|llc)$/i;
  const quoted = /^[“"「『]([^”"」』]{2,40})[”"」』]/;
  for (const slot of slots) {
    if (!["user", "tool"].includes(slot.source)) continue;
    const original = slot.owner[slot.key];
    if (environmentText(original)) continue;
    const text = recognitionText(original.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, "\n"), true);
    const definitions = /[（(，,][ \t]*(?:(?:以下|下文)(?:简称|亦称|称)|简称(?:为)?)[ \t]*[：:]?[ \t]*(?=[“"「『])/g;
    for (const marker of text.matchAll(definitions)) {
      const prefix = text.slice(Math.max(0, marker.index - 180), marker.index).trimEnd();
      const full = detectNames(prefix).filter(n => prefix.endsWith(n) && (LEGAL_NAME.test(n) || /(?:Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|L\.L\.C\.|PLC|GmbH)$/i.test(n))).sort((a, b) => b.length - a.length)[0];
      if (!full || /(?:例如|示例|举例|样例|例子|假设|虚构)/.test(prefix.slice(prefix.lastIndexOf("\n") + 1, -full.length))) continue;
      let tail = text.slice(marker.index + marker[0].length, marker.index + marker[0].length + 180);
      for (let count = 0; count < 4; count++) {
        const match = quoted.exec(tail);
        if (!match) break;
        const alias = match[1].trim();
        if (/^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9 &·.\-]{1,31}$/.test(alias) && nameFieldValue(alias) && !generic.test(alias) && alias.toLowerCase() !== full.toLowerCase()) {
          const key = alias.toLowerCase(), prior = relations.get(key);
          if (prior && prior.full.toLowerCase() !== full.toLowerCase()) blocked.add(key);
          else relations.set(key, {alias, full});
          // Never accept an early subset while skipping possible conflicts.
          if (relations.size > 128) return {names: [], conflicts: blocked.size, limited: true};
        }
        const rest = tail.slice(match[0].length), next = /^[ \t]*(?:或|、|及|和|\/)[ \t]*(?=[“"「『])/.exec(rest);
        if (!next) break;
        tail = rest.slice(next[0].length);
      }
    }
  }
  return {names: [...relations].filter(([key]) => !blocked.has(key)).map(([, value]) => value.alias), conflicts: blocked.size, limited: false};
}

export function escapeRE(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Share common prefixes rather than making the engine retry thousands of
// complete names at each character. Longer names still take precedence.
export function namePattern(names) {
  const root = new Map();
  for (const name of names.slice().sort((a,b)=>b.length-a.length)) {
    let node = root;
    for (const c of name) {
      const upper = c.length === 1 ? c.toUpperCase() : c;
      const key = upper.length === 1 && !(c.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : c;
      if (!node.has(key)) node.set(key,new Map());
      node = node.get(key);
    }
    node.set("",null);
  }
  const render = node => {
    let prefix = "";
    while (node.size === 1 && !node.has("")) {
      const [c,next] = node.entries().next().value;
      prefix += escapeRE(c); node = next;
    }
    const branches = [];
    for (const [c,next] of node) if (c) branches.push(escapeRE(c)+render(next));
    if (node.has("")) branches.push("");
    return prefix + (branches.length > 1 ? "(?:"+branches.join("|")+")" : branches[0] || "");
  };
  return render(root);
}
