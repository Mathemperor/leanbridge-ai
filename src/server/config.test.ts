import { describe, expect, it } from "vitest";
import { loadConfig, toPublicConfig } from "./config";

describe("loadConfig", () => {
  it("uses current model and bounded repair defaults", () => {
    const config = loadConfig({ DEMO_MODE: "true" });
    expect(config).toMatchObject({
      demoMode: true,
      model: "gpt-5.6",
      reasoningEffort: "high",
      maxRepairAttempts: 3,
      leanTimeoutMs: 30_000,
    });
  });

  it("requires an API key outside demo mode", () => {
    expect(() => loadConfig({ DEMO_MODE: "false" })).toThrow(/OPENAI_API_KEY/);
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
      backendToken: "token",
      leanProjectPath: "/app/lean-project",
    });
    expect(toPublicConfig(config).lean.mode).toBe("cloud");
  });
});
