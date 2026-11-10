// 手动起服务用：node serve.mjs [--port 3496]
import { startServer } from "./lib/server.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const value = Number(arg("port", process.env.MAGPIE_MODEL_QUOTA_PORT || 3496));
const info = await startServer({ port: Number.isInteger(value) && value > 0 ? value : 3496 });
console.log(`[model-quota] listening on http://127.0.0.1:${info.port}`);
