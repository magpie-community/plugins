import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  apiCatalog as fallbackCatalog,
  type JsonSchema,
  type PublicApiDefinition,
} from './catalog-fallback.ts';

const CATALOG_PATH = '/api/v1/mcp/catalog';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// After a failed read, the next ones answer at once from what is kept
// instead of each waiting out the timeout again.
const RETRY_AFTER_FAILURE_MS = 60_000;

type CatalogState = {
  catalog?: readonly PublicApiDefinition[];
  fetchedAt: number;
  failedAt: number;
};

const catalogState = new Map<string, CatalogState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  if (!isRecord(value)) return false;
  if (
    value.type !== 'object' &&
    value.type !== 'string' &&
    value.type !== 'integer' &&
    value.type !== 'number' &&
    value.type !== 'boolean' &&
    value.type !== 'array'
  ) {
    return false;
  }
  if (value.type === 'object' && value.properties !== undefined) {
    if (!isRecord(value.properties)) return false;
    if (!Object.values(value.properties).every(isJsonSchema)) return false;
  }
  if (value.type === 'array' && value.items !== undefined && !isJsonSchema(value.items)) {
    return false;
  }
  return true;
}

function isPublicDefinition(value: unknown): value is PublicApiDefinition {
  if (!isRecord(value)) return false;
  return (
    value.method === 'GET' &&
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    /^\/api\/v1\/[a-z0-9/_-]+$/.test(value.path) &&
    typeof value.mcpName === 'string' &&
    /^goanyapi_[a-z0-9_]+$/.test(value.mcpName) &&
    typeof value.description === 'string' &&
    value.readOnly === true &&
    isJsonSchema(value.inputSchema)
  );
}

// The valid entries of a catalog payload; an invalid entry is dropped, not
// the whole catalog. A payload with none is an error.
function parseApis(data: unknown): readonly PublicApiDefinition[] {
  if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.apis)) {
    throw new Error('Catalog response has an unsupported schema version.');
  }
  const catalog = data.apis.filter(isPublicDefinition);
  if (catalog.length === 0) throw new Error('Catalog response has no valid API definition.');
  return catalog;
}

function parseCatalog(value: unknown): readonly PublicApiDefinition[] {
  if (!isRecord(value) || value.code !== 'ok' || !isRecord(value.data)) {
    throw new Error('Catalog response has an invalid envelope.');
  }
  return parseApis(value.data);
}

async function fetchCatalog(baseUrl: string): Promise<readonly PublicApiDefinition[]> {
  const response = await fetch(`${baseUrl}${CATALOG_PATH}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Catalog request failed with status ${response.status}.`);
  return parseCatalog(text ? JSON.parse(text) : null);
}

function normalize(baseUrl: string) {
  return baseUrl.replace(/\/$/, '');
}

// The catalog the last live read left on disk, for this base only.
function readDisk(baseUrl: string, diskPath?: string): readonly PublicApiDefinition[] | undefined {
  if (!diskPath) return undefined;
  try {
    const kept = JSON.parse(readFileSync(diskPath, 'utf8'));
    if (!isRecord(kept) || kept.base !== baseUrl) return undefined;
    return parseApis(kept);
  } catch {
    return undefined;
  }
}

// Written to a temp file and renamed over the old one, so a reader never
// sees half of it.
function writeDisk(baseUrl: string, diskPath: string | undefined, catalog: readonly PublicApiDefinition[]) {
  if (!diskPath) return;
  const temp = `${diskPath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(temp, JSON.stringify({ schemaVersion: 1, base: baseUrl, apis: catalog }), { mode: 0o600 });
    renameSync(temp, diskPath);
  } catch {}
}

// cachedCatalog answers without the network: the last live read in this
// process, else the one kept on disk, else the bundled copy.
export function cachedCatalog(baseUrl: string, diskPath?: string): readonly PublicApiDefinition[] {
  const base = normalize(baseUrl);
  return catalogState.get(base)?.catalog ?? readDisk(base, diskPath) ?? fallbackCatalog;
}

// loadApiCatalog reads the live catalog unless one read less than
// maxAgeMs ago is kept (0: always read). While a read failed less than a
// minute ago it answers from cachedCatalog at once.
export async function loadApiCatalog(
  baseUrl: string,
  maxAgeMs = DEFAULT_CACHE_TTL_MS,
  diskPath?: string
): Promise<readonly PublicApiDefinition[]> {
  const base = normalize(baseUrl);
  const state = catalogState.get(base) ?? { fetchedAt: 0, failedAt: 0 };
  catalogState.set(base, state);
  const now = Date.now();
  if (state.catalog && now - state.fetchedAt < maxAgeMs) return state.catalog;
  if (state.failedAt && now - state.failedAt < RETRY_AFTER_FAILURE_MS) {
    return cachedCatalog(base, diskPath);
  }
  try {
    const catalog = await fetchCatalog(base);
    state.catalog = catalog;
    state.fetchedAt = Date.now();
    state.failedAt = 0;
    writeDisk(base, diskPath, catalog);
    return catalog;
  } catch (error) {
    state.failedAt = Date.now();
    console.warn('Unable to load the remote GoAnyAPI catalog; using the last one kept.', String(error));
    return cachedCatalog(base, diskPath);
  }
}

export function clearCatalogCache() {
  catalogState.clear();
}

export { fallbackCatalog };
