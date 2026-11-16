// Agent plugin for PI-Desktop.
//
// magpie runs this module in its moejs process: no imports, no Node APIs, no
// timers. It only writes the sidecar file, ~/.pi-desktop/magpie-agent.json.
// The package's Bun module (sync.mjs) copies that file into PI-Desktop's
// pi.sqlite; this module never touches the database itself.

export const agent = {
  // magpie reserves "pi-desktop" for its own PI-Desktop sessions integration.
  // Use a free id and keep the expected CLI names as aliases.
  id: "pi-desktop-app",
  name: "PI-Desktop",
  aliases: ["pi-desktop", "pidesktop"],
  bin: "PI-Desktop",
  // PI-Desktop resolves its data folder as join(os.homedir(), ".pi-desktop")
  // on Windows, macOS and Linux alike; magpie expands ~ against the user home.
  dir: "~/.pi-desktop",
  config: "~/.pi-desktop/magpie-agent.json",
  format: "json",
  model: "model",
  effort: false,
  wsl: false,
  notice: "模型已同步到 PI-Desktop；重新打开它的模型选择器即可看到。",
};

export function connect({ gateway, model, models }) {
  return {
    baseUrl: gateway.v1,
    apiKey: gateway.key,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context,
      output: m.output,
    })),
    modelName: model.name,
  };
}

export function own() {
  return [];
}
