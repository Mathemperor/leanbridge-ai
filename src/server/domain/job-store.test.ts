import { describe, expect, it } from "vitest";
import type { Translation, VerificationResult } from "@shared/proof";
import { InMemoryJobStore } from "./job-store";

const translation: Translation = {
  normalizedSource: "P",
  theoremSummary: "P",
  assumptions: [],
  imports: ["Mathlib"],
  leanCode: "theorem p : True := by trivial",
  notes: [],
};

const verification: VerificationResult = {
  ok: true,
  status: "verified",
  command: "lean Main.lean",
  durationMs: 1,
  output: "ok",
  diagnostics: [],
  exitCode: 0,
};

describe("InMemoryJobStore", () => {
  it("creates a queued job without echoing the source payload", () => {
    const store = new InMemoryJobStore();
    const job = store.create({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      autoRepair: true,
    });

    expect(job).toMatchObject({ mode: "image", status: "queued", attempts: [] });
    expect(JSON.stringify(job)).not.toContain("aGVsbG8=");
  });

  it("returns undefined for an unknown job", () => {
    expect(new InMemoryJobStore().get("missing")).toBeUndefined();
  });

  it("releases uploaded image bytes after model translation", () => {
    const store = new InMemoryJobStore();
    const job = store.create({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      autoRepair: true,
    });

    store.releaseLargeInput(job.id);

    expect(JSON.stringify(store.getStored(job.id))).not.toContain("aGVsbG8=");
  });

  it("evicts the oldest terminal job at the capacity limit", () => {
    const store = new InMemoryJobStore({ maxJobs: 2 });
    const first = store.create({ mode: "latex", latex: "P", autoRepair: false });
    store.finish(first.id, "failed");
    const second = store.create({ mode: "latex", latex: "Q", autoRepair: false });
    const third = store.create({ mode: "latex", latex: "R", autoRepair: false });

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeDefined();
    expect(store.get(third.id)).toBeDefined();
  });

  it("rejects new work when every retained job is active", () => {
    const store = new InMemoryJobStore({ maxJobs: 1 });
    store.create({ mode: "latex", latex: "P", autoRepair: false });

    expect(() => store.create({ mode: "latex", latex: "Q", autoRepair: false }))
      .toThrow(/capacity/i);
  });

  it("bounds attempt and event history within one retained job", () => {
    const store = new InMemoryJobStore();
    const job = store.create({ mode: "latex", latex: "P", autoRepair: false });

    for (let index = 0; index < 100; index += 1) {
      store.recordTranslation(job.id, translation, "manual");
      store.recordVerification(job.id, verification);
      store.transition(job.id, "verifying", `attempt ${index}`);
    }

    expect(store.get(job.id)?.attempts).toHaveLength(4);
    expect(store.get(job.id)?.events.length).toBeLessThanOrEqual(64);
    expect(store.get(job.id)?.attempts.at(-1)?.number).toBe(100);
  });
});
