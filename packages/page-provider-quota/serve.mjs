import { startServer } from "./lib/server.mjs";

const service = await startServer({
  port: Number(process.env.MAGPIE_PROVIDER_QUOTA_PORT ?? 3497),
});

console.log(`Magpie Provider Quota（账号额度）：http://127.0.0.1:${service.port}/`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    service.server.close(() => process.exit(0));
    service.server.closeIdleConnections();
  });
}
