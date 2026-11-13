// Magpie runs this descriptor in moejs. Node APIs belong in the Bun companion.
export const agent = {
  id: 'trae-local',
  name: 'Trae',
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzI0RERBMyI+PHRpdGxlPlRSQUU8L3RpdGxlPjxwYXRoIGQ9Ik0yNCAyMC41NDFIMy40Mjh2LTMuNDI2SDBWMy40aDI0VjIwLjU0ek0zLjQyOCAxNy4xMTVoMTcuMTQ0VjYuODI3SDMuNDI4djEwLjI4OHptOC41NzMtNS4xOTZsLTIuNDI1IDIuNDI0LTIuNDI0LTIuNDI0IDIuNDI0LTIuNDI0IDIuNDI1IDIuNDI0em02Ljg1Ny0uMDAxbC0yLjQyNCAyLjQyMy0yLjQyNS0yLjQyMyAyLjQyNS0yLjQyNSAyLjQyNCAyLjQyNXoiLz48L3N2Zz4K",
  dir: '$APPDATA/Trae CN',
  config: '~/.config/magpie-trae/connection.json',
  format: 'json',
  ua: [],
  library: {
    instructions: '~/.trae-cn/user_rules/magpie.md',
    mcp: '$APPDATA/Trae CN/User/mcp.json',
    mcpFormat: 'claude',
    skills: '~/.trae-cn/skills',
  },
  notice: '自动同步模型、图片能力和思考档位；移除或断开时撤回未手动修改的条目。首次安装刷新组件后重启 Trae 一次，之后目录变化自动刷新。',
};

export function connect({ gateway, models }) {
  if (!gateway?.v1 || !gateway?.key) throw new Error('Configure a Magpie gateway first.');
  return {
    version: 2,
    baseURL: gateway.v1,
    gatewayKey: gateway.key,
    models: (models || []).map(m => ({
      id: m.id, name: m.name || m.id,
      context: m.context || 0, output: m.output || 0,
      images: !!m.images, efforts: m.efforts || [],
    })),
  };
}
