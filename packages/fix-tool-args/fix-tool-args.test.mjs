// fix-tool-args.test.mjs — runs cases.json the way the repository's CI does,
// and adds assertions the harness cannot express: the repaired arguments are
// valid JSON, the emitted call carries the original id and name, and a
// client-side join of the emitted stream parses as an object.
import { check, cases } from "../../scripts/middleware.mjs";
import * as mod from "./fix-tool-args.middleware.js";

check(import.meta.dir, mod);

// Client-side assembler: join fragments per index, like pi-ai does.
function assemble(events) {
  const calls = {};
  const order = [];
  let finish = null;
  for (const ev of events) {
    if (ev === "[DONE]" || typeof ev !== "object") continue;
    for (const ch of ev.choices || []) {
      if (ch.finish_reason) finish = ch.finish_reason;
      for (const tc of (ch.delta || {}).tool_calls || []) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        if (!calls[idx]) { calls[idx] = { id: "", name: "", args: "" }; order.push(idx); }
        if (tc.id) calls[idx].id = tc.id;
        if (tc.function?.name) calls[idx].name = tc.function.name;
        if (typeof tc.function?.arguments === "string") calls[idx].args += tc.function.arguments;
      }
    }
  }
  return { calls, order, finish };
}

test("client-side: the spark shape parses after the middleware", () => {
  const c = cases(import.meta.dir)[0];
  const events = [];
  const ctx = { protocol: "chat", stream: true, options: {}, state: {} };
  for (const e of c.events) {
    if (typeof e.data !== "object") { events.push(e.data); continue; }
    const r = mod.onEvent(JSON.parse(JSON.stringify(e.data)), ctx);
    if (r === null) continue;
    events.push(r ?? e.data);
  }
  const a = assemble(events);
  expect(a.finish).toBe("tool_calls");
  expect(a.order).toEqual([0]);
  expect(JSON.parse(a.calls[0].args)).toEqual({ pattern: "**/*fd86512e*" });
  expect(a.calls[0].id).toBe("call_1");
  expect(a.calls[0].name).toBe("ops_glob");
});
