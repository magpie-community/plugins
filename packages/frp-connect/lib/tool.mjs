// A tool an agent may call: OpenCode's shape ({description, args,
// execute}), with args as plain JSON Schema. No `args` at all is refused
// by magpie's check, so every tool here has one — {} when it takes none.

// NO_ARGS is a tool's args when it takes none: a JSON Schema object, not
// an empty one, which magpie's check reads as no args at all.
export const NO_ARGS = { type: "object", properties: {} };

export function tool({ description, args = NO_ARGS, execute }) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("a tool's args are a JSON Schema object");
  }
  return { description, args, execute };
}
