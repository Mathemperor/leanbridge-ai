import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startMemorySampler } from "./memory-sampler";

it("separates the current compilation's sampled peak from the container lifetime peak", () => {
  const directory = mkdtempSync(join(tmpdir(), "leanbridge-memory-test-"));
  vi.useFakeTimers();
  try {
    writeFileSync(join(directory, "memory.current"), "60000000\n");
    writeFileSync(join(directory, "memory.peak"), "510000000\n");
    const sampler = startMemorySampler(directory);
    writeFileSync(join(directory, "memory.current"), "250000000\n");
    vi.advanceTimersByTime(250);
    writeFileSync(join(directory, "memory.current"), "80000000\n");
    expect(sampler?.stop()).toMatchObject({
      sampledPeakBytes: 250000000, currentAfterBytes: 80000000,
      containerLifetimePeakBytes: 510000000, sampleIntervalMs: 200,
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not start a sampler when cgroup memory accounting is unavailable", () => {
  expect(startMemorySampler(join(tmpdir(), "leanbridge-no-cgroup-here"))).toBeUndefined();
});
