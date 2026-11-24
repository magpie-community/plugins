// Cteno (https://cteno.cn) keeps its model profiles in profiles.json inside its
// OS app-data folder (com.cteno-host.gui: ~/Library/Application Support on
// macOS, %APPDATA% on Windows, $XDG_DATA_HOME or ~/.local/share on Linux, or
// $CTENO_APP_DATA_DIR), as a "profiles" array plus "default_profile_id".
//
// Magpie's moejs agent sandbox edits a single static file by object keys, so
// it writes the chosen model and gateway endpoint to connection.json here, and
// index.mjs (running in Magpie's plugin host) updates only the id="magpie"
// entry in Cteno's profiles.json and restores the user's file on disconnect.
export const agent = {
  id: "cteno",
  name: "Cteno",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgcng9IjIyIiBmaWxsPSIjMEYzQjU3Ii8+PHBhdGggZD0iTTYwIDIwLjVIMzYuNVEyMC41IDIwLjUgMjAuNSAzNi41djI3UTIwLjUgNzkuNSAzNi41IDc5LjVINjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIxMyIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxyZWN0IHg9IjQ3IiB5PSIzMiIgd2lkdGg9IjI2IiBoZWlnaHQ9IjgiIHJ4PSI0IiBmaWxsPSIjRkZGRkZGIi8+PHJlY3QgeD0iNTQiIHk9IjQ2IiB3aWR0aD0iMzIiIGhlaWdodD0iOCIgcng9IjQiIGZpbGw9IiM2RkQ2RTIiLz48cmVjdCB4PSI0NyIgeT0iNjAiIHdpZHRoPSIyNiIgaGVpZ2h0PSI4IiByeD0iNCIgZmlsbD0iI0ZGRkZGRiIvPjwvc3ZnPg==",
  bin: "cteno-host-cli",
  dir: "~/.cteno",
  config: "~/.config/magpie-cteno/connection.json",
  format: "json",
  model: "model",
  ua: ["cteno"],
  notice: "Cteno reads its model profiles at start-up — restart Cteno to use this. Cteno 在启动时读取模型配置，切换后请重启 Cteno。",
}

export function connect({ gateway, model }) {
  const info = {}
  if (Number.isSafeInteger(model?.context) && model.context > 0) info.context = model.context
  if (Number.isSafeInteger(model?.output) && model.output > 0) {
    info.output = info.context ? Math.min(model.output, info.context) : model.output
  }
  if (typeof model?.images === "boolean") info.images = model.images
  if (Array.isArray(model?.efforts) && model.efforts.some((e) => e && e !== "none" && e !== "off")) {
    info.thinking = true
  }
  return {
    baseURL: gateway.v1,
    gatewayKey: gateway.key,
    modelInfo: info,
  }
}
