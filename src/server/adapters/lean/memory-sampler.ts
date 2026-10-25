import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_INTERVAL_MS = 200;

function readCounter(directory: string, name: string): number | undefined {
  try {
    const value = Number(readFileSync(join(directory, name), "utf8").trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function startMemorySampler(directory = "/sys/fs/cgroup") {
  const initial = readCounter(directory, "memory.current");
  if (initial === undefined) return undefined;
  let current = initial;
  let peak = initial;
  let sampleCount = 1;
  const sample = () => {
    const value = readCounter(directory, "memory.current");
    if (value === undefined) return;
    current = value;
    peak = Math.max(peak, value);
    sampleCount += 1;
  };
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return {
        sampledPeakBytes: peak,
        currentAfterBytes: current,
        containerLifetimePeakBytes: readCounter(directory, "memory.peak"),
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        sampleCount,
      };
    },
  };
}
