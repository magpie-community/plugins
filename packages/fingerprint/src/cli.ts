import { startServer } from './server';
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(
    'Magpie Fingerprint\n  bun start [--demo] [--port 4388]\nEnvironment: MAGPIE_FINGERPRINT_GATEWAY, MAGPIE_FINGERPRINT_API_KEY, MAGPIE_FINGERPRINT_DATA_DIR, MAGPIE_FINGERPRINT_BANK_SOURCE',
  );
  process.exit(0);
}
const at = argv.indexOf('--port');
const service = await startServer({
  demo: argv.includes('--demo'),
  ...(at >= 0 ? { port: Number(argv[at + 1]) } : {}),
});
console.log(
  `Magpie Fingerprint: http://127.0.0.1:${service.port}${service.demo ? ' (demo; no provider requests)' : ''}`,
);
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.on(event, async () => {
    await service.close();
    process.exit(0);
  });
