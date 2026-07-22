import { describe, expect, it } from "vitest";
import type { ProofRequest, Translation, VerificationResult } from "@shared/proof";
import type { LeanVerifier, ProofModel, RepairContext, VerifyOptions } from "./ports";
import { InMemoryJobStore } from "./job-store";
import { ProofPipeline } from "./proof-pipeline";

const source: ProofRequest = {
  mode: "latex",
  latex: "Prove that n = n.",
  projectPath: "/tmp/mathlib",
  autoRepair: true,
};

const initial: Translation = {
  normalizedSource: "For every n, n equals n.",
  theoremSummary: "Reflexivity",
  assumptions: ["n : Nat"],
  imports: ["Mathlib"],
  leanCode: "import Mathlib\ntheorem reflNat (n : Nat) : n = n := by exact broken",
  notes: [],
};

const repaired: Translation = {
  ...initial,
  leanCode: "import Mathlib\ntheorem reflNat (n : Nat) : n = n := by rfl",
  notes: ["Replaced the unknown proof term with reflexivity."],
};

const failed: VerificationResult = {
  ok: false,
  status: "failed",
  command: "lake env lean Main.lean",
  durationMs: 10,
  output: "Main.lean:2:50: error: unknown identifier 'broken'",
  diagnostics: [{ severity: "error", line: 2, column: 50, message: "unknown identifier 'broken'" }],
  exitCode: 1,
};

const verified: VerificationResult = {
  ok: true,
  status: "verified",
  command: "lake env lean Main.lean",
  durationMs: 8,
  output: "Lean verification succeeded.",
  diagnostics: [],
  exitCode: 0,
};

class FakeModel implements ProofModel {
  repairs: RepairContext[] = [];
  failure?: unknown;

  async translate(): Promise<Translation> {
    if (this.failure) throw this.failure;
    return initial;
  }

  async repair(context: RepairContext): Promise<Translation> {
    this.repairs.push(context);
    return repaired;
  }
}

class QueueVerifier implements LeanVerifier {
  readonly calls: Array<{ code: string; options: VerifyOptions }> = [];

  constructor(private readonly results: VerificationResult[]) {}

  async verify(code: string, options: VerifyOptions): Promise<VerificationResult> {
    this.calls.push({ code, options });
    return this.results.shift() ?? failed;
  }
}

function harness(results: VerificationResult[], maxRepairAttempts = 3) {
  const store = new InMemoryJobStore();
  const model = new FakeModel();
  const verifier = new QueueVerifier(results);
  const pipeline = new ProofPipeline({
    model,
    verifier,
    store,
    maxRepairAttempts,
    verifyDefaults: { timeoutMs: 1_234 },
  });
  return { store, model, verifier, pipeline };
}

describe("ProofPipeline", () => {
  it("finishes a valid initial translation", async () => {
    const { pipeline, verifier } = harness([verified]);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    expect(pipeline.get(job.id)).toMatchObject({
      status: "verified",
      translation: initial,
      verification: { ok: true },
    });
    expect(verifier.calls[0]?.options).toEqual({ timeoutMs: 1_234, projectPath: "/tmp/mathlib" });
  });

  it("repairs a compiler failure and finishes verified", async () => {
    const { pipeline, model, verifier } = harness([failed, verified]);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result?.status).toBe("verified");
    expect(result?.attempts.map(({ kind }) => kind)).toEqual(["initial", "repair"]);
    expect(model.repairs).toHaveLength(1);
    expect(model.repairs[0]?.diagnostics).toContain("unknown identifier");
    expect(verifier.calls).toHaveLength(2);
  });

  it("preserves the latest code when repairs are exhausted", async () => {
    const { pipeline, model } = harness([failed, failed, failed], 2);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result).toMatchObject({ status: "failed", translation: repaired });
    expect(result?.attempts).toHaveLength(3);
    expect(model.repairs).toHaveLength(2);
  });

  it("does not repair when auto repair is disabled", async () => {
    const { pipeline, model } = harness([failed]);
    const job = pipeline.start({ ...source, autoRepair: false });

    await pipeline.run(job.id);

    expect(pipeline.get(job.id)?.status).toBe("failed");
    expect(model.repairs).toHaveLength(0);
  });

  it("records a redacted structured provider failure", async () => {
    const { pipeline, model } = harness([]);
    model.failure = Object.assign(
      new Error("Incorrect API key sk-proj-super-secret"),
      { status: 401, code: "invalid_api_key", type: "invalid_request_error" },
    );
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/status=401.*code=invalid_api_key.*type=invalid_request_error/),
    });
    expect(result?.error).toContain("sk-[redacted]");
    expect(result?.error).not.toContain("super-secret");
  });

  it("re-verifies manually edited Lean without calling the model", async () => {
    const { pipeline, model } = harness([verified, verified]);
    const job = pipeline.start(source);
    await pipeline.run(job.id);

    const updated = await pipeline.reverify(job.id, "theorem manual : True := by trivial");

    expect(updated.status).toBe("verified");
    expect(updated.attempts.at(-1)).toMatchObject({ kind: "manual", verification: { ok: true } });
    expect(model.repairs).toHaveLength(0);
  });

  it("does not grow translation notes across repeated manual verification", async () => {
    const { pipeline } = harness([verified]);
    const job = pipeline.start(source);
    await pipeline.run(job.id);

    let updated = pipeline.get(job.id);
    for (let index = 0; index < 100; index += 1) {
      updated = await pipeline.reverify(job.id, "theorem manual : True := by trivial");
    }

    expect(updated?.translation?.notes).toHaveLength(1);
    expect(updated?.translation?.notes[0]).toMatch(/用户手动编辑后重新验证/);
    expect(updated?.attempts).toHaveLength(4);
  });
});
