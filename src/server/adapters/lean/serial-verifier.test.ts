import { describe, expect, it } from "vitest";
import type { VerificationResult } from "@shared/proof";
import type { LeanVerifier } from "@server/domain/ports";
import { SerialLeanVerifier } from "./serial-verifier";

const verified: VerificationResult = {
  ok: true,
  status: "verified",
  command: "lean Main.lean",
  durationMs: 1,
  output: "Lean verification succeeded.",
  diagnostics: [],
  exitCode: 0,
};

describe("SerialLeanVerifier", () => {
  it("runs only one Lean verification at a time", async () => {
    let active = 0;
    let maximum = 0;
    const inner: LeanVerifier = {
      async verify() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return verified;
      },
    };

    const verifier = new SerialLeanVerifier(inner);
    await Promise.all([verifier.verify("a", {}), verifier.verify("b", {})]);

    expect(maximum).toBe(1);
  });

  it("continues the queue after an inner verifier rejects", async () => {
    let calls = 0;
    const inner: LeanVerifier = {
      async verify() {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return verified;
      },
    };

    const verifier = new SerialLeanVerifier(inner);
    await expect(verifier.verify("first", {})).rejects.toThrow("boom");
    await expect(verifier.verify("second", {})).resolves.toMatchObject({ ok: true });
  });

  it("rejects work when the bounded queue is full", async () => {
    let release: (() => void) | undefined;
    const inner: LeanVerifier = {
      async verify() {
        await new Promise<void>((resolve) => { release = resolve; });
        return verified;
      },
    };
    const verifier = new SerialLeanVerifier(inner, { maxPending: 1 });

    const first = verifier.verify("first", { timeoutMs: 1_000 });
    await Promise.resolve();
    const overflow = verifier.verify("overflow", { timeoutMs: 1_000 });
    release?.();
    await expect(overflow).rejects.toThrow(/queue is full/i);
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("includes time spent waiting in the verification timeout", async () => {
    let calls = 0;
    const inner: LeanVerifier = {
      async verify() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return verified;
      },
    };
    const verifier = new SerialLeanVerifier(inner, { maxPending: 2 });

    const first = verifier.verify("first", { timeoutMs: 100 });
    const queued = verifier.verify("queued", { timeoutMs: 10 });

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: false, status: "timeout" });
    expect(calls).toBe(1);
  });
});
