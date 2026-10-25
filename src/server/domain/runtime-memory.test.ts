import { describe, expect, it, vi } from "vitest";
import { RuntimeMemoryCoordinator } from "./runtime-memory";

describe("RuntimeMemoryCoordinator", () => {
  it("serializes codex and lean tasks so heavy subprocesses never overlap", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const coordinator = new RuntimeMemoryCoordinator({
      idleEvictionMs: 0,
      evictPageCache: async () => {},
      collectGarbage: () => {},
    });

    const first = coordinator.runExclusive("lean", async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      order.push("lean-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("lean-end");
      active -= 1;
      return "lean-ok";
    });

    const second = coordinator.runExclusive("codex", async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      order.push("codex-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("codex-end");
      active -= 1;
      return "codex-ok";
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["lean-ok", "codex-ok"]);
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["lean-start", "lean-end", "codex-start", "codex-end"]);
  });

  it("evicts page cache immediately after each Lean run by default", async () => {
    const events: string[] = [];
    const coordinator = new RuntimeMemoryCoordinator({
      idleEvictionMs: 0,
      evictPageCache: async () => {
        events.push("evict");
      },
      collectGarbage: () => {},
    });

    await coordinator.runExclusive("lean", async () => {
      events.push("lean-1");
    });
    await coordinator.runExclusive("codex", async () => {
      events.push("codex-1");
    });

    expect(events).toEqual(["lean-1", "evict", "codex-1"]);
  });

  it("evicts warm Lean page cache before starting Codex when evictAfterEachLean is false", async () => {
    const events: string[] = [];
    const coordinator = new RuntimeMemoryCoordinator({
      idleEvictionMs: 0,
      evictAfterEachLean: false,
      evictPageCache: async () => {
        events.push("evict");
      },
      collectGarbage: () => {},
    });

    await coordinator.runExclusive("codex", async () => {
      events.push("codex-1");
    });
    await coordinator.runExclusive("lean", async () => {
      events.push("lean-1");
    });
    await coordinator.runExclusive("lean", async () => {
      events.push("lean-2");
    });
    await coordinator.runExclusive("codex", async () => {
      events.push("codex-2");
    });

    expect(events).toEqual(["codex-1", "lean-1", "lean-2", "evict", "codex-2"]);
  });

  it("evicts warm Lean page cache after the idle timeout expires", async () => {
    vi.useFakeTimers();
    try {
      let evictions = 0;
      const coordinator = new RuntimeMemoryCoordinator({
        idleEvictionMs: 1_000,
        evictAfterEachLean: false,
        evictPageCache: async () => {
          evictions += 1;
        },
        collectGarbage: () => {},
      });

      await coordinator.runExclusive("lean", async () => "ok");
      expect(evictions).toBe(0);

      await vi.advanceTimersByTimeAsync(999);
      expect(evictions).toBe(0);

      await vi.advanceTimersByTimeAsync(2);
      expect(evictions).toBe(1);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
