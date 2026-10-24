import { describe, expect, it } from "vitest";
import request from "supertest";
import { writeFile } from "node:fs/promises";
import { createApp } from "./app";
import { loadConfig, toPublicConfig } from "./config";
import { ProofPipeline } from "./domain/proof-pipeline";
import { CodexProofModel } from "./adapters/model/codex-proof-model";
import type { ProofRequest } from "@shared/proof";

const translation = { normalizedSource: "True", theoremSummary: "True", assumptions: [], imports: [], leanCode: "example : True := by trivial", notes: [] };
const verified = { ok: true, status: "verified" as const, command: "test lean", durationMs: 1, output: "", diagnostics: [], exitCode: 0 };
function fixture() {
  const calls: string[][] = [];
  const model = new CodexProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, async (_command, args) => {
    calls.push(args);
    await writeFile(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify(translation));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  });
  const pipeline = new ProofPipeline({ model, verifier: { verify: async () => verified } });
  const app = createApp({ pipeline, publicConfig: toPublicConfig(loadConfig({ MODEL_PROVIDER: "codex" })) });
  return { app, pipeline, calls, model };
}

describe("per-proof Codex subscription selection", () => {
  it("publishes only supported public models and model-specific effort choices", async () => {
    const { body } = await request(fixture().app).get("/api/config");
    expect(body.codexCatalog.defaultModel).toBe("gpt-6-astra");
    expect(body.codexCatalog.defaultReasoningEffort).toBe("high");
    expect(body.codexCatalog.models.find((m: { id: string }) => m.id === "gpt-6-astra").reasoningEfforts).toContain("ultra");
    expect(body.codexCatalog.models.find((m: { id: string }) => m.id === "gpt-6-luna").reasoningEfforts).not.toContain("ultra");
    expect(JSON.stringify(body)).not.toMatch(/gpt-reserve|codex-auto-review|API_KEY/);
  });
  it("keeps old clients on the server default and records the selected pair", async () => {
    const { app } = fixture();
    const original = await request(app).post("/api/proofs").send({ mode: "latex", latex: "True" });
    expect(original.body.modelConfig).toEqual({ model: "gpt-6-astra", reasoningEffort: "high" });
    const changed = await request(app).post("/api/proofs").send({ mode: "latex", latex: "True", model: "gpt-6.1-sol", reasoningEffort: "medium" });
    expect(changed.status).toBe(202);
    expect(changed.body.modelConfig).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "medium" });
    expect((await request(app).get(`/api/proofs/${changed.body.id}`)).body.modelConfig).toEqual(changed.body.modelConfig);
    expect((await request(app).post("/api/proofs/manual").send({ code: translation.leanCode })).body.modelConfig).toBeUndefined();
  });
  it.each([
    { model: "untrusted-model", reasoningEffort: "high" },
    { model: "gpt-6-luna", reasoningEffort: "ultra" },
    { model: "gpt-6-astra", reasoningEffort: "minimal" },
  ])("rejects unsupported selection before starting a CLI job: %j", async selection => {
    const { app, calls } = fixture();
    const response = await request(app).post("/api/proofs").send({ mode: "latex", latex: "True", ...selection });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("isolates queued selections and uses the same settings during image repair after image release", async () => {
    const { model, calls } = fixture();
    let verifications = 0;
    const pipeline = new ProofPipeline({ model, verifier: { verify: async () => ++verifications === 1
      ? { ...verified, ok: false, status: "failed", exitCode: 1, output: "type mismatch" } : verified } });
    const image = pipeline.start({ mode: "image", imageDataUrl: "data:image/png;base64,dGVzdA==", autoRepair: true, model: "gpt-6.1-sol", reasoningEffort: "medium" } as ProofRequest);
    await pipeline.run(image.id);
    expect(pipeline.get(image.id)?.status).toBe("verified");
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
      expect(args).toContain('model_reasoning_effort="medium"');
      expect(args).toContain('forced_login_method="chatgpt"');
    }
    expect(calls[0]).toContain("--image");
    expect(calls[1]).not.toContain("--image");
    await Promise.all([
      model.translate({ mode: "latex", latex: "True", autoRepair: false, model: "gpt-6-astra", reasoningEffort: "max" } as ProofRequest),
      model.translate({ mode: "latex", latex: "True", autoRepair: false, model: "gpt-6-luna", reasoningEffort: "low" } as ProofRequest),
    ]);
    expect(calls[2]).toContain('model_reasoning_effort="max"');
    expect(calls[3]).toContain('model_reasoning_effort="low"');
    expect(pipeline.get(image.id)?.modelConfig).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "medium" });
  });
});
