import { describe, expect, it } from "vitest";
import { loadConfig, toPublicConfig } from "./config";

describe("loadConfig", () => {
  it("uses current OpenAI model and bounded repair defaults", () => {
    const config = loadConfig({ DEMO_MODE: "true" });
    expect(config).toMatchObject({
      demoMode: true,
      provider: "openai",
      model: "gpt-5.6",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      leanTimeoutMs: 30_000,
    });
  });

  it("requires an OpenAI API key for the OpenAI provider", () => {
    expect(() => loadConfig({ DEMO_MODE: "false" })).toThrow(/OPENAI_API_KEY/);
  });

  it("selects Nebius Nemotron and requires a Nebius key", () => {
    expect(() => loadConfig({
      DEMO_MODE: "false",
      MODEL_PROVIDER: "nebius",
    })).toThrow(/NEBIUS_API_KEY/);

    const config = loadConfig({
      DEMO_MODE: "false",
      MODEL_PROVIDER: "nebius",
      NEBIUS_API_KEY: "nebius-test",
    });

    expect(config).toMatchObject({
      provider: "nebius",
      apiKey: "nebius-test",
      model: "nvidia/nemotron-3-super-120b-a12b",
      baseURL: "https://api.tokenfactory.us-central1.nebius.com/v1/",
    });
    expect(toPublicConfig(config).provider).toBe("nebius");
  });

  it("accepts an explicit Nebius model and Token Factory base URL", () => {
    const config = loadConfig({
      MODEL_PROVIDER: "nebius",
      NEBIUS_API_KEY: "nebius-test",
      NEBIUS_MODEL: "nvidia/custom-nemotron",
      NEBIUS_BASE_URL: "https://example.nebius.test/v1/",
    });
    expect(config).toMatchObject({
      provider: "nebius",
      model: "nvidia/custom-nemotron",
      baseURL: "https://example.nebius.test/v1/",
    });
  });

  it("rejects unsupported providers", () => {
    expect(() => loadConfig({
      MODEL_PROVIDER: "mystery",
      OPENAI_API_KEY: "sk-test",
    })).toThrow(/MODEL_PROVIDER/);
  });

  it("clamps the repair budget to five", () => {
    expect(loadConfig({ DEMO_MODE: "true", MAX_REPAIR_ATTEMPTS: "99" }).maxRepairAttempts).toBe(5);
  });

  it("requires all production secrets in cloud mode", () => {
    expect(() => loadConfig({ CLOUD_MODE: "true" })).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({
      CLOUD_MODE: "true",
      OPENAI_API_KEY: "sk-test",
    })).toThrow(/LEANBRIDGE_BACKEND_TOKEN/);
    expect(() => loadConfig({
      CLOUD_MODE: "true",
      OPENAI_API_KEY: "sk-test",
      LEANBRIDGE_BACKEND_TOKEN: "token",
    })).toThrow(/LEAN_PROJECT_PATH/);
  });

  it("never enables demo adapters in cloud mode", () => {
    const config = loadConfig({
      CLOUD_MODE: "true",
      DEMO_MODE: "true",
      OPENAI_API_KEY: "sk-test",
      LEANBRIDGE_BACKEND_TOKEN: "token",
      LEAN_PROJECT_PATH: "/app/lean-project",
    });

    expect(config).toMatchObject({
      cloudMode: true,
      demoMode: false,
      provider: "openai",
      backendToken: "token",
      leanProjectPath: "/app/lean-project",
    });
    expect(toPublicConfig(config).lean.mode).toBe("cloud");
  });
});
