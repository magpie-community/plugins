// Runs in magpie's own process (moejs): no Node, no imports.
// It does not touch UEBox's models.json (providers is an array, which magpie's
// key-path writer would replace whole). It writes a small link file instead;
// index.mjs, in the plugin host, folds it into models.json.

export const agent = {
  id: "uebox",
  name: "UEBox",
  // UEBox's own mark (ueboxai/uebox build/icon.svg), inline because this
  // module runs in moejs and can import nothing.
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj4KICA8cmVjdCB4PSIzMiIgeT0iMzIiIHdpZHRoPSI0NDgiIGhlaWdodD0iNDQ4IiByeD0iMTEyIiBmaWxsPSIjZjdmN2Y3IiBzdHJva2U9IiNkOGRhZGQiIHN0cm9rZS13aWR0aD0iOCIgLz4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNiAxNikgc2NhbGUoNy41KSIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgc3Ryb2tlLWxpbmVqb2luPSJtaXRlciI+CiAgICA8cGF0aCBkPSJNMjcgMTBIMTB2MTdNMzcgMTBoMTd2MTdNNTQgMzd2MTdIMzdNMjcgNTRIMTBWMzciIHN0cm9rZT0iIzE3MTkxYiIgc3Ryb2tlLXdpZHRoPSI3IiAvPgogICAgPHBhdGggZD0ibTI3IDIzIDExIDktMTEgOSIgc3Ryb2tlPSIjN2M4Mzg5IiBzdHJva2Utd2lkdGg9IjYiIC8+CiAgPC9nPgo8L3N2Zz4K",
  config: "~/.config/magpie/uebox-link.json",
  format: "json",
  dir: "$APPDATA/unreal-box",
  ua: ["uebox", "unreal-box"],
  notice: "UEBox reads its model settings when it starts: restart UEBox, or open Settings → Models, then pick a magpie model under Default models.",
}

export function connect({ gateway, models }) {
  return {
    magpie_key: gateway.key,
    magpie_url: gateway.url,
    magpie_v1: gateway.v1,
    magpie_models: (models || []).map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context,
      output: m.output,
      images: m.images,
      efforts: m.efforts,
    })),
  }
}
