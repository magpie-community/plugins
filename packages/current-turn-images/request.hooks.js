import {filterRequest} from './filter.js';
import {measureRequest} from './metrics.js';
import {recordRequest} from './journal.js';
import {addCacheAnchors} from './cache-anchors.js';
import {compressRequest} from './compression.js';

export async function onRequest(body, ctx) {
  // The filter is shared with the preceding middleware version. Measurements
  // are stored separately and never inserted into the request or its messages.
  const prepared = addCacheAnchors(body, ctx);
  const result = filterRequest(prepared.body, ctx.protocol);
  // Do not spend CPU compressing history that the request filter removes.
  const configured = ctx.options?.imageCompression || {};
  const hookBudget = Number.isFinite(ctx.options?.gatewayTimeoutMs) ? ctx.options.gatewayTimeoutMs : 1000;
  const requestedBudget = Number.isFinite(configured.maxMilliseconds) ? configured.maxMilliseconds : 2500;
  const imageOptions = {...configured, maxMilliseconds: Math.min(requestedBudget, Math.max(50, hookBudget - 250))};
  const compression = await compressRequest(result?.body ?? prepared.body, ctx.protocol, imageOptions, ctx.signal);
  const measured = result ? {...result, body: compression.body, compression} : undefined;
  const record = measureRequest(body, measured, ctx);
  record.cacheAnchorsAdded = prepared.added;
  try {
    await recordRequest(record, ctx.options);
  } catch {
    ctx.report?.('unavailable', 0);
    console.error('[current-turn-images] metrics_write_failed');
  }
  if (prepared.added > 0 || result?.stats.removedImages > 0 || compression.compressedImages > 0) return compression.body;
}
