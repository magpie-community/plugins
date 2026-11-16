// Tern agent plugin for magpie.
//
// Tern's built-in agent panel runs omp (oh-my-pi). omp reads two files under
// ~/.omp/agent:
//   - models.yml  provider catalog (base URL, API flavour, auth, models)
//   - config.yml  start-up settings (modelRoles.default, theme, …)
//
// `magpie tern <model>` writes the selected model to modelRoles.default and
// opens a "magpie" provider in models.yml that points at this machine's
// gateway. The prefix makes the value in config.yml `magpie/<model>`, which is
// the provider-qualified id omp expects.
//
// magpie runs this module in its moejs process: no imports, no Node APIs, no
// timers, no side effects. Only `agent` and `connect` are read. Everything
// that needs the filesystem (config.yaml migration, enabledModels merge) lives
// in sync.mjs, the Bun main.

export const agent = {
  id: "tern",
  name: "Tern",
  aliases: ["tern-terminal"],
  bin: "tern",
  config: "~/.omp/agent/models.yml",
  format: "yaml",
  startup: {
    config: "~/.omp/agent/config.yml",
    format: "yaml",
    model: "modelRoles.default",
  },
  prefix: "magpie/",
  effort: false,
  wsl: false,
  notice: "omp 在启动时读取配置：重新打开 Tern 的 agent 块后生效。",
};

// omp's thinking-effort vocabulary (verified against omp 18.20.2). magpie
// models may carry extra levels ("none", "ultra"); keep only what omp knows.
const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function connect({ gateway, models }) {
  return {
    "providers.magpie": {
      baseUrl: gateway.v1,
      api: "openai-completions",
      auth: "none",
      models: models.map((m) => {
        const entry = { id: m.id, name: m.name };
        if (m.context > 0) entry.contextWindow = m.context;
        if (m.output > 0) entry.maxTokens = m.output;
        const efforts = (Array.isArray(m.efforts) ? m.efforts : []).filter((x) =>
          OMP_EFFORTS.includes(x),
        );
        entry.reasoning = efforts.length > 0;
        if (efforts.length) entry.thinking = { mode: "effort", efforts };
        return entry;
      }),
    },
  };
}
