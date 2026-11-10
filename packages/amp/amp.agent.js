export const agent = {
  id: "amp",
  name: "Amp",
  bin: "amp",
  dir: "~",
  config: "~/.config/magpie-amp/control.json",
  format: "json",
  model: "model",
  notice: "Run magpie-amp sync to apply the selected model remotely. Run magpie-amp disconnect before uninstalling. Removing this package does not deactivate the Amp route.",
};

export function connect() {
  return { version: 1 };
}
