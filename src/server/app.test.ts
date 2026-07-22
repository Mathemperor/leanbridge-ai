import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProofRequest, Translation, VerificationResult } from "@shared/proof";
import type { LeanVerifier, ProofModel, VerifyOptions } from "./domain/ports";
import { ProofPipeline } from "./domain/proof-pipeline";
import { InMemoryJobStore } from "./domain/job-store";
import { createApp } from "./app";

const translation: Translation = {
  normalizedSource: "Truth is true.",
  theoremSummary: "Truth introduction",
  assumptions: [],
  imports: ["Mathlib"],
  leanCode: "import Mathlib\ntheorem truth : True := by trivial",
  notes: [],
};

const verified: VerificationResult = {
  ok: true,
  status: "verified",
  command: "demo lean",
  durationMs: 1,
  output: "Lean verification succeeded.",
  diagnostics: [],
  exitCode: 0,
};

class Model implements ProofModel {
  async translate(_source: ProofRequest): Promise<Translation> {
    return translation;
  }
  async repair(): Promise<Translation> {
    return translation;
  }
}

class Verifier implements LeanVerifier {
  async verify(): Promise<VerificationResult> {
    return verified;
  }
}

function makeApp(options: {
  backendToken?: string;
  cloudMode?: boolean;
  readinessVerifier?: LeanVerifier;
  readinessOptions?: VerifyOptions;
  storeMaxJobs?: number;
} = {}) {
  const { storeMaxJobs, ...appOptions } = options;
  const pipeline = new ProofPipeline({
    model: new Model(),
    verifier: new Verifier(),
    ...(storeMaxJobs === undefined ? {} : { store: new InMemoryJobStore({ maxJobs: storeMaxJobs }) }),
  });
  return createApp({
    pipeline,
    ...appOptions,
    publicConfig: {
      provider: "demo",
      model: "gpt-5.6",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      lean: { mode: "demo", projectConfigured: false },
    },
  });
}

describe("LeanBridge HTTP API", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  it("creates an asynchronous proof job", async () => {
    const response = await request(app).post("/api/proofs").send({
      mode: "latex",
      latex: "\\begin{proof}trivial\\end{proof}",
      autoRepair: true,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: expect.any(String), status: "queued" });
  });

  it("returns 429 when the in-memory job store is at capacity", async () => {
    const capacityApp = makeApp({ storeMaxJobs: 0 });
    const response = await request(capacityApp).post("/api/proofs").send({
      mode: "latex",
      latex: "truth",
      autoRepair: true,
    });

    expect(response.status).toBe(429);
    expect(response.body.error).toMatch(/任务过多/);
  });

  it("rejects invalid input with field issues", async () => {
    const response = await request(app).post("/api/proofs").send({
      mode: "latex",
      latex: "",
      autoRepair: true,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "输入内容无效", issues: expect.any(Object) });
  });

  it("allows polling until verification completes", async () => {
    const created = await request(app).post("/api/proofs").send({
      mode: "latex",
      latex: "truth",
      autoRepair: true,
    });
    const id = created.body.id as string;

    let result = await request(app).get(`/api/proofs/${id}`);
    for (let attempt = 0; attempt < 20 && result.body.status !== "verified"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await request(app).get(`/api/proofs/${id}`);
    }

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "verified", translation, verification: { ok: true } });
  });

  it("re-verifies manually edited source", async () => {
    const created = await request(app).post("/api/proofs").send({ mode: "latex", latex: "truth", autoRepair: true });
    const id = created.body.id as string;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await request(app)
      .post(`/api/proofs/${id}/verify`)
      .send({ code: "theorem manual : True := by trivial" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "verified" });
    expect(response.body.attempts.at(-1)).toMatchObject({ kind: "manual" });
  });

  it("returns 404 for an unknown proof", async () => {
    const response = await request(app).get("/api/proofs/unknown");
    expect(response.status).toBe(404);
  });

  it("exposes capability state without exposing the API key", async () => {
    const response = await request(app).get("/api/config");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ provider: "demo", model: "gpt-5.6" });
    expect(JSON.stringify(response.body)).not.toMatch(/OPENAI_API_KEY|sk-/);
  });

  it("reports health", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: "leanbridge" });
  });

  it("protects backend API routes with a bearer token", async () => {
    const protectedApp = makeApp({ backendToken: "correct-token" });

    expect((await request(protectedApp).get("/api/health")).status).toBe(200);
    expect((await request(protectedApp).get("/api/config")).status).toBe(401);
    expect((await request(protectedApp)
      .get("/api/config")
      .set("Authorization", "Bearer correct-token")).status).toBe(200);
  });

  it("rejects user-controlled project paths in cloud mode", async () => {
    const cloudApp = makeApp({ cloudMode: true });
    const response = await request(cloudApp).post("/api/proofs").send({
      mode: "latex",
      latex: "truth",
      autoRepair: true,
      projectPath: "/tmp/untrusted",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/工程路径/);
  });

  it("reports real Lean readiness through the configured verifier", async () => {
    const readyApp = makeApp({ readinessVerifier: new Verifier() });
    const response = await request(readyApp).get("/api/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, lean: "ready" });
  });

  it("returns 503 when the Lean readiness probe fails", async () => {
    const failedVerifier: LeanVerifier = {
      async verify() {
        return { ...verified, ok: false, status: "failed", exitCode: 1 };
      },
    };
    const response = await request(makeApp({ readinessVerifier: failedVerifier })).get("/api/ready");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, lean: "unavailable" });
  });
});
