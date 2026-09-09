import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeEnvironment } from "./secret-env";

describe("loadRuntimeEnvironment", () => {
  it("loads Docker secrets from a one-time file and removes it", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "leanbridge-secrets-test-"));
    const path = resolve(directory, "runtime");
    await writeFile(path, Buffer.from("openai-test\0nebius-test\0tvly-test\0token-test-value\0"));

    try {
      const runtime = loadRuntimeEnvironment({
        CLOUD_MODE: "true",
        LEANBRIDGE_SECRET_FILE: path,
      });

      expect(runtime).toMatchObject({
        OPENAI_API_KEY: "openai-test",
        NEBIUS_API_KEY: "nebius-test",
        TAVILY_API_KEY: "tvly-test",
        LEANBRIDGE_BACKEND_TOKEN: "token-test-value",
      });
      expect(runtime.LEANBRIDGE_SECRET_FILE).toBeUndefined();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports a Nebius plus Tavily Docker deployment", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "leanbridge-secrets-test-"));
    const path = resolve(directory, "runtime");
    await writeFile(path, Buffer.from("\0nebius-only\0tvly-only\0backend-token\0"));

    try {
      const runtime = loadRuntimeEnvironment({ LEANBRIDGE_SECRET_FILE: path });
      expect(runtime.OPENAI_API_KEY).toBeUndefined();
      expect(runtime.NEBIUS_API_KEY).toBe("nebius-only");
      expect(runtime.TAVILY_API_KEY).toBe("tvly-only");
      expect(runtime.LEANBRIDGE_BACKEND_TOKEN).toBe("backend-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
