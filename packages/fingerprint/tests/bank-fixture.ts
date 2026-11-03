import { createHash } from 'node:crypto';

// An empty, internally consistent SDK reference fixture, never used for scoring.
export function cacheFixture() {
  const detector = Buffer.from(
    JSON.stringify({
      schema: 'shared-detector-v2',
      bank_built_at: 'test-snapshot',
      model_ids: [],
      response_counts: [],
    }),
  );
  const detectorHeader = Buffer.alloc(Math.ceil((4 + detector.length) / 4) * 4);
  detectorHeader.writeUInt32LE(detector.length);
  detector.copy(detectorHeader, 4);
  const bank = Buffer.from(
    JSON.stringify({
      schema: 'lmfpd-data-v1',
      detector_schema: 'shared-detector-v2',
      built_at: 'test-snapshot',
      models: [],
      files: {
        'shared_detector.bin': {
          sha256: createHash('sha256').update(detectorHeader).digest('hex'),
          parts: ['fixture.zst'],
        },
      },
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bank.length);
  return Buffer.concat([length, bank, detectorHeader]);
}
