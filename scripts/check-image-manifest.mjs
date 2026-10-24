import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkManifest(manifest) {
  assert(manifest?.schemaVersion === 2 && !manifest.manifests && Array.isArray(manifest.layers) && manifest.layers.length > 0,
    'Expected a single-platform image manifest');
  const sizes = [manifest.config, ...manifest.layers].map(blob => blob?.size);
  assert(sizes.every(size => Number.isSafeInteger(size) && size >= 0), 'Invalid registry blob size');
  const compressedBytes = sizes.reduce((sum, size) => sum + size, 0);
  assert(Number.isSafeInteger(compressedBytes), 'Invalid total registry size');
  // Decimal 4 GB is the conservative boundary; final Railway admission is
  // checked separately because platform accounting may differ from blob size.
  const limitBytes = 4_000_000_000;
  assert(compressedBytes <= limitBytes, `Registry image ${compressedBytes} bytes exceeds the ${limitBytes}-byte Free-plan gate`);
  return { compressedBytes, limitBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkManifest(JSON.parse(readFileSync(0, 'utf8')));
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Registry image blobs: ${result.compressedBytes} bytes; size gate: ${result.limitBytes} bytes.\n`);
  }
}
