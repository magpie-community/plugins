import {randomUUID} from 'node:crypto';
import {visitImages} from './filter.js';

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function embeddedBytes(part) {
  let data;
  if (part.type === 'image' && part.source?.type === 'base64') data = part.source.data;
  if (part.type === 'image' && typeof part.data === 'string') data = part.data;
  const inline = part.inlineData || part.inline_data;
  if (inline) data = inline.data;
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url === 'string' && /^data:[^,]*;base64,/i.test(url)) data = url.slice(url.indexOf(',') + 1);
  if (typeof data !== 'string') return null;
  const clean = data.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  if (padding > 0 && clean.length % 4 !== 0) return null;
  return Math.floor(clean.length * 3 / 4) - padding;
}

export function measureRequest(original, result, ctx) {
  const body = result?.body ?? original;
  const stats = result?.stats ?? {protocol: ctx.protocol, removedImages: 0, affectedMessages: 0, placeholderMessages: 0, keptCurrentImages: 0};
  const removed = result?.removedParts ?? [];
  const images = result?.images ?? result?.userImages ?? [];
  const removedDetails = removed.map(({messageIndex, partIndex, path, role, part}) => ({messageIndex, partIndex,
    ...(path ? {path, role} : {}), jsonBytes: jsonBytes(part), embeddedBytes: embeddedBytes(part)}));
  const requestBytesBefore = jsonBytes(original);
  const requestBytesAfter = jsonBytes(body);
  const imageJsonBytesBefore = images.reduce((sum, part) => sum + jsonBytes(part), 0);
  const removedImageJsonBytes = removedDetails.reduce((sum, part) => sum + part.jsonBytes, 0);
  let imageJsonBytesAfter = 0;
  const historyKey = ctx.protocol === 'responses' ? 'input' : ctx.protocol === 'gemini' ? 'contents' : 'messages';
  const outgoingHistory = body?.[historyKey];
  if (Array.isArray(outgoingHistory)) for (const message of outgoingHistory) visitImages(message, ctx.protocol, part => { imageJsonBytesAfter += jsonBytes(part); });
  const compression = result?.compression;
  return {
    schemaVersion: 5, id: randomUUID(), time: new Date().toISOString(),
    imagePolicy: result?.policy || 'unrecognized', currentInputStart: result?.currentInputStart ?? null,
    agent: ctx.agent || '', model: ctx.model || original.model || '',
    ...stats,
    requestBytesBefore, requestBytesAfter, savedBytes: requestBytesBefore - requestBytesAfter,
    imageJsonBytesBefore, imageJsonBytesAfter,
    compressedImages: compression?.compressedImages || 0,
    compressionSavedFileBytes: compression?.savedFileBytes || 0,
    compressionSavedRequestBytes: compression?.savedRequestBytes || 0,
    compressionDetails: compression?.details || [],
    removedImageJsonBytes,
    removedEmbeddedBytesKnown: removedDetails.reduce((sum, part) => sum + (part.embeddedBytes ?? 0), 0),
    removedUnknownFileSizes: removedDetails.filter(part => part.embeddedBytes === null).length,
    removedDetails,
    inspected: !!result,
  };
}
