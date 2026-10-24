import assert from 'node:assert/strict';
import { test } from 'vitest';
import { checkManifest } from './check-image-manifest.mjs';

const manifest = sizes => ({ schemaVersion: 2, config: { size: 100 }, layers: sizes.map(size => ({ size })) });
test('counts compressed registry blobs at the 4 GB boundary', () => {
  assert.equal(checkManifest(manifest([3_999_999_900])).compressedBytes, 4_000_000_000);
});
test('rejects an image above the free-plan threshold', () => {
  assert.throws(() => checkManifest(manifest([3_999_999_901])), /exceeds/);
});
test('requires a single-platform manifest rather than silently counting an index as empty', () => {
  assert.throws(() => checkManifest({ schemaVersion: 2, manifests: [] }), /single-platform/);
});
test('rejects missing or invalid descriptor sizes', () => {
  for (const bad of [undefined, -1, NaN, '10', 1.5]) {
    assert.throws(() => checkManifest(manifest([bad])), /size/);
  }
});
