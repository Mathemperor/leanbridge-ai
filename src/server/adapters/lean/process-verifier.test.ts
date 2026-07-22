import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leanSubprocessEnvironment, ProcessLeanVerifier } from "./process-verifier";

const here = dirname(fileURLToPath(import.meta.url));
const fakeLean = resolve(here, "../../../../test/fixtures/fake-lean.mjs");
let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "leanbridge-project-"));
  await chmod(fakeLean, 0o755);
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("ProcessLeanVerifier", () => {
  it("does not pass application secrets to Lean", () => {
    const env = leanSubprocessEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/leanbridge",
      OPENAI_API_KEY: "api-test-value",
      LEANBRIDGE_BACKEND_TOKEN: "token-test-value",
      LEANBRIDGE_SECRET_FILE: "/tmp/secret",
    });

    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/leanbridge" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LEANBRIDGE_BACKEND_TOKEN).toBeUndefined();
    expect(env.LEANBRIDGE_SECRET_FILE).toBeUndefined();
  });

  it("verifies source through a shell-free executable", async () => {
    const verifier = new ProcessLeanVerifier();
    const result = await verifier.verify("example : True := by trivial", {
      projectPath,
      leanCommand: fakeLean,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "verified",
      exitCode: 0,
      command: expect.stringContaining("fake-lean.mjs"),
    });
    expect(result.output).toContain("Lean proof verified");
  });

  it("returns parsed compiler diagnostics", async () => {
    const verifier = new ProcessLeanVerifier();
    const result = await verifier.verify("example : False := by fail_if_success trivial", {
      projectPath,
      leanCommand: fakeLean,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ ok: false, status: "failed", exitCode: 1 });
    expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 3, severity: "error" });
  });

  it("reports a missing Lean executable", async () => {
    const verifier = new ProcessLeanVerifier();
    const result = await verifier.verify("example : True := by trivial", {
      projectPath,
      leanCommand: resolve(projectPath, "does-not-exist"),
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ ok: false, status: "missing" });
    expect(result.output).toMatch(/not found|ENOENT/i);
  });

  it("terminates verification after the configured timeout", async () => {
    const verifier = new ProcessLeanVerifier();
    const result = await verifier.verify("-- HANG\nexample : True := by trivial", {
      projectPath,
      leanCommand: fakeLean,
      timeoutMs: 40,
    });

    expect(result).toMatchObject({ ok: false, status: "timeout" });
    expect(result.durationMs).toBeLessThan(1_000);
  });
});
