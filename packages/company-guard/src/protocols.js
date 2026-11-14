import { environmentText, webTool } from "./policy.js";

const NAME_FIELD = /^(?:company(?:_name)?|customer(?:_name)?|supplier(?:_name)?|counterparty(?:_name)?|entity_name|公司名称|客户名称|供应商名称|交易对手名称)$/i;
const OPAQUE_FIELD = /^(?:id|type|role|tool_call_id|tool_use_id|call_id|signature|encrypted_content|data|image_url|file_data|file_id|mime_type|mimeType|media_type)$/;

export function inspectRequest(body, protocol) {
  const slots = [], records = [], calls = Object.create(null);
  let nodes = 0;
  const add = (owner, key, meta = {}) => { if (typeof owner?.[key] === "string") slots.push({owner, key, ...meta}); };
  const data = (value, meta, depth = 0) => {
    if (++nodes > 50000 || depth > 48) throw new Error("input_structure_limit");
    if (!value || typeof value !== "object") return;
    for (const k of Object.keys(value)) {
      if (OPAQUE_FIELD.test(k)) continue;
      if (typeof value[k] === "string") add(value, k, {...meta, nameField: NAME_FIELD.test(k) ? k : null});
      else data(value[k], meta, depth + 1);
    }
  };
  const blocks = (value, meta, depth = 0) => {
    if (++nodes > 50000 || depth > 48) throw new Error("input_structure_limit");
    if (!Array.isArray(value)) { data(value, meta, depth + 1); return; }
    for (const p of value) {
      if (!p || typeof p !== "object") continue;
      if (["text", "input_text", "output_text", "summary_text", "reasoning_text"].includes(p.type) || (!p.type && typeof p.text === "string")) add(p, "text", meta);
      else if (p.type === "thinking") add(p, "thinking", {...meta, sealed: !!p.signature});
      else if (p.type === "tool_result") {
        const m = {...meta, source: "tool", tool: calls[p.tool_use_id] || ""};
        if (typeof p.content === "string") add(p, "content", m); else blocks(p.content, m, depth + 1);
      } else if (p.type === "tool_use") data(p.input, {...meta, source: "call", tool: p.name || ""}, depth + 1);
      else if (p.type === "resource") { if (p.resource) add(p.resource, "text", meta); }
      else if (p.functionCall) data(p.functionCall.args, {...meta, source: "call", tool: p.functionCall.name || ""}, depth + 1);
      else if (p.functionResponse) data(p.functionResponse.response, {...meta, source: "tool", tool: p.functionResponse.name || ""}, depth + 1);
      else if (p.type === "input_file" || p.type === "file") add(p, "filename", meta);
    }
  };

  let list;
  if (protocol === "responses") list = Array.isArray(body.input) ? body.input : [];
  else if (protocol === "gemini") list = Array.isArray(body.contents) ? body.contents : [];
  else list = Array.isArray(body.messages) ? body.messages : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "function_call" || m.type === "custom_tool_call") calls[m.call_id] = m.name || "";
    for (const c of m.tool_calls || []) if (c) calls[c.id] = c.function?.name || "";
    for (const p of Array.isArray(m.content) ? m.content : []) if (p?.type === "tool_use") calls[p.id] = p.name || "";
  }
  if (protocol === "responses" && typeof body.input === "string") {
    add(body, "input", {source: "user", index: 0}); records.push({index: 0, role: "user", text: body.input});
  }
  for (let index = 0; index < list.length; index++) {
    const m = list[index]; if (!m || typeof m !== "object") continue;
    const source = ["system", "developer"].includes(m.role) ? "instruction" : m.role === "user" ? "user" : ["tool", "function"].includes(m.role) ? "tool" : "assistant";
    const meta = {source, index, tool: calls[m.tool_call_id] || (source === "tool" ? m.name || "" : "")};
    const before = slots.length;
    if (typeof m.content === "string") add(m, "content", meta); else blocks(m.content, meta);
    blocks(m.parts, meta);
    if (m.type === "function_call_output" || m.type === "custom_tool_call_output") {
      const sm = {...meta, source: "tool", tool: calls[m.call_id] || ""};
      if (typeof m.output === "string") add(m, "output", sm); else data(m.output, sm);
    } else if (m.type === "function_call") add(m, "arguments", {...meta, source: "call", tool: m.name || "", json: true});
    else if (m.type === "custom_tool_call") add(m, "input", {...meta, source: "call", tool: m.name || ""});
    else if (m.type === "reasoning") blocks(m.summary, {...meta, source: "assistant"});
    for (const c of m.tool_calls || []) if (c?.function) add(c.function, "arguments", {...meta, source: "call", tool: c.function.name || "", json: true});
    if (m.function_call) add(m.function_call, "arguments", {...meta, source: "call", tool: m.function_call.name || "", json: true});
    const own = slots.slice(before).filter(s => s.source === "user" && s.index === index).map(s => s.owner[s.key]).join("\n");
    records.push({index, role: m.role || m.type || "unknown", text: own});
  }
  add(body, "instructions", {source: "instruction", index: -1});
  if (typeof body.system === "string") add(body, "system", {source: "instruction", index: -1}); else blocks(body.system, {source: "instruction", index: -1});
  if (body.systemInstruction) blocks(body.systemInstruction.parts, {source: "instruction", index: -1});
  const schema = (v, depth = 0) => {
    if (!v || typeof v !== "object") return;
    if (++nodes > 50000 || depth > 48) throw new Error("input_structure_limit");
    for (const k of Object.keys(v)) {
      if (["description", "title"].includes(k)) add(v, k, {source: "schema", index: -1});
      else if (k === "enum" && Array.isArray(v[k])) for (let i = 0; i < v[k].length; i++) add(v[k], i, {source: "schema", index: -1});
      else if (typeof v[k] === "object") schema(v[k], depth + 1);
    }
  };
  schema(body.tools);
  const user = records.filter(r => r.role === "user" && r.text && !environmentText(r.text)).at(-1) || null;
  return {slots, records, user};
}

export function publicContextSafe(view, allowed) {
  if (!view.user) return false;
  for (const r of view.records) {
    if (r.index >= view.user.index || ["system", "developer"].includes(r.role)) continue;
    if (r.role !== "user" || !environmentText(r.text)) return false;
  }
  for (const s of view.slots) {
    if ((s.source === "instruction" || s.index < view.user.index) && [...allowed].some(n => s.owner[s.key].includes(n))) return false;
    if (["tool", "call"].includes(s.source) && !webTool(s.tool)) return false;
  }
  return true;
}

export function safeInput(body, protocol) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 80000 || depth > 64) throw new Error("input_structure_limit");
    if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("unsafe_numeric_value");
    if (!v || typeof v !== "object") return;
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(body, 0);
  // Preserve remote context, reasoning and client cache controls. Previously
  // transmitted originals cannot be revoked by rewriting a later request.
}
