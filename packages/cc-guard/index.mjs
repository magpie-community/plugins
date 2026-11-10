import plugin from "./provider.mjs";

export const CcGuardPlugin = plugin.server;
// OpenCode 2.x (plugins#657): a default {id, setup}. The provider's server
// function is the setup: it takes the context and options and returns hooks.
export default { id: plugin.id, setup: plugin.server };
