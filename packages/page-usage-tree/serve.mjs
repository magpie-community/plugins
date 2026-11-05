import { startServer } from "./lib/server.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const port = Number(arg("--port", process.env.MAGPIE_USAGE_TREE_PORT || 3494));
const currency = arg("--currency", process.env.MAGPIE_USAGE_TREE_CURRENCY || "usd");
const usdCny = Number(arg("--usd-cny", process.env.MAGPIE_USAGE_TREE_USD_CNY || 0));
const chineseUnits = arg("--chinese-units", "") === "1";

const info = await startServer({ port, currency, usdCny, chineseUnits });
console.log(`[usage-tree] listening on http://127.0.0.1:${info.port}`);
