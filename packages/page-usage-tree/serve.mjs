import { startServer } from "./lib/server.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const port = Number(arg("--port", process.env.MAGPIE_USAGE_TREE_PORT || 3488));
const usdCny = Number(arg("--usd-cny", process.env.MAGPIE_USAGE_TREE_USD_CNY || 7.2));

const info = await startServer({ port, usdCny });
console.log(`[usage-tree] listening on http://127.0.0.1:${info.port}`);
