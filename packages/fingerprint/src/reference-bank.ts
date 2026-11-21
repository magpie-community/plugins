import { open } from 'node:fs/promises';
import { boundedText } from './http';

export const BANK_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BANK_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const MANIFEST_LIMIT = 1024 * 1024;

type Manifest = {
  schema?: string;
  detector_schema?: string;
  built_at?: string;
  models?: unknown[];
  files?: Record<string, { sha256?: string }>;
};

function bankVersion(manifest: Manifest) {
  return manifest.files?.['shared_detector.bin']?.sha256;
}

export async function readBankManifest(path: string) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    if ((await file.read(header)).bytesRead !== header.length)
      throw new Error('Missing reference cache header');
    const length = header.readUInt32LE(0);
    if (length > MANIFEST_LIMIT) throw new Error('Reference cache manifest is too large');
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes)).bytesRead !== length)
      throw new Error('Truncated reference cache manifest');
    const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
    return { length, modelCount: manifest.models?.length, version: bankVersion(manifest) };
  } finally {
    await file.close();
  }
}

export async function probeReferenceSource(source: string) {
  const response = await fetch(`${source}bundle.json`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const manifest = JSON.parse(await boundedText(response, MANIFEST_LIMIT)) as Manifest;
  if (manifest.schema !== 'lmfpd-data-v1' || manifest.detector_schema !== 'shared-detector-v2')
    throw new Error('Incompatible reference data format');
  const version = bankVersion(manifest);
  const builtAt = manifest.built_at;
  if (
    typeof version !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(version) ||
    typeof builtAt !== 'string' ||
    !builtAt
  )
    throw new Error('Missing reference version');
  return { source, version, builtAt };
}

export type RemoteBank = Awaited<ReturnType<typeof probeReferenceSource>>;

export async function verifyBankDownload(path: string, remote: RemoteBank, builtAt: string) {
  const { length, version } = await readBankManifest(path);
  if (version !== remote.version || builtAt !== remote.builtAt)
    throw new Error('Reference data changed during download. Check again to retry.');
  const bytes = await Bun.file(path)
    .slice(4 + length)
    .arrayBuffer();
  const digest = new Bun.CryptoHasher('sha256').update(new Uint8Array(bytes)).digest('hex');
  if (digest !== version.toLowerCase()) throw new Error('Reference data checksum mismatch');
}
