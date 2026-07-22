import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeEnvironment } from "./secret-env";

describe("loadRuntimeEnvironment", () => {
  it("loads Docker secrets from a one-time file and removes it", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "leanbridge-secrets-test-"));
    const path = resolve(directory, "runtime");
    await writeFile(path, Buffer.from("api-test-value\0token-test-value\0"));

    try {
      const runtime = loadRuntimeEnvironment({
        CLOUD_MODE: "true",
        LEANBRIDGE_SECRET_FILE: path,
      });

      expect(runtime).toMatchObject({
        OPENAI_API_KEY: "api-test-value",
        LEANBRIDGE_BACKEND_TOKEN: "token-test-value",
      });
      expect(runtime.LEANBRIDGE_SECRET_FILE).toBeUndefined();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
