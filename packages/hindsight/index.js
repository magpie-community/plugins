// This file lets Magpie's GitHub discovery recognize a gateway-only package.
// Runtime hooks live in hooks.mjs and are declared by package.json magpie.hooks.
export const _internal = {
  hooks: "./hooks.mjs",
  note: "Magpie asynchronous gateway hook plugin; see hooks.mjs."
};
