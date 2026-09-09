import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(root, relativePath), "utf8");
}

describe("cloud deployment configuration", () => {
  it("pins the Lean and mathlib releases", async () => {
    await expect(read("lean-project/lean-toolchain")).resolves.toBe("leanprover/lean4:v4.24.0\n");
    await expect(read("lean-project/lakefile.toml")).resolves.toMatch(/rev\s*=\s*"v4\.24\.0"/);
    await expect(read("lean-project/LeanBridge/Basic.lean")).resolves.toContain("import Mathlib");
    const manifest = JSON.parse(await read("lean-project/lake-manifest.json")) as {
      packages: Array<{ name: string; rev: string }>;
    };
    expect(manifest.packages.find((entry) => entry.name === "mathlib")?.rev)
      .toBe("f897ebcf72cd16f89ab4577d0c826cd14afaafc7");
  });

  it("builds a non-root cloud runtime without embedding secrets", async () => {
    const dockerfile = await read("Dockerfile");
    const entrypoint = await read("docker-entrypoint.sh");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain("ENV CLOUD_MODE=true");
    expect(dockerfile).toContain("ENV LEAN_PROJECT_PATH=/app/lean-project");
    expect(dockerfile).toMatch(/USER\s+leanbridge/);
    expect(dockerfile).toContain("docker-entrypoint.sh");
    expect(dockerfile).not.toMatch(/RUN\s+chmod\s+-R\s+a-w\s+\/app\s+\/opt\/elan/);
    expect(dockerfile).toMatch(/COPY\s+--chmod=0444\s+package\.json\s+package-lock\.json\s+\.\//);
    expect(dockerfile).toMatch(/COPY\s+--chmod=0555\s+--from=lean-environment\s+\/opt\/elan\s+\/opt\/elan/);
    expect(dockerfile).toMatch(/COPY\s+--chmod=0555\s+--from=lean-environment\s+\/app\/lean-project\s+\.\/lean-project/);
    expect(dockerfile).not.toContain("lake update");
    expect(dockerfile).not.toMatch(/OPENAI_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/NEBIUS_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/LEANBRIDGE_BACKEND_TOKEN\s*=/);
    expect(entrypoint).toContain("unset OPENAI_API_KEY NEBIUS_API_KEY LEANBRIDGE_BACKEND_TOKEN");
    expect(entrypoint).toContain("/tmp/leanbridge-secrets.*");
    expect(entrypoint).toContain("exec \"$@\"");
  });

  it("bypasses Lake dependency materialization in the read-only runtime", async () => {
    const dockerfile = await read("Dockerfile");
    const wrapper = await read("docker-lean-wrapper.sh");
    expect(dockerfile).toContain("lake env printenv LEAN_PATH > .lean-path");
    expect(dockerfile).toContain("elan which lean > .lean-bin");
    expect(dockerfile).toContain("ENV LAKE_COMMAND=/usr/local/bin/leanbridge-lake-env");
    expect(dockerfile).toContain(
      "COPY --chmod=0555 docker-lean-wrapper.sh /usr/local/bin/leanbridge-lake-env",
    );
    expect(wrapper).toContain('[ "$1" = "env" ]');
    expect(wrapper).toContain('[ "$2" = "lean" ]');
    expect(wrapper).toContain("export LEAN_PATH");
    expect(wrapper).toContain('exec "$lean_bin" "$3"');
  });

  it("uses Railway's Dockerfile builder and public health endpoint", async () => {
    const railway = JSON.parse(await read("railway.json")) as {
      build?: { builder?: string };
      deploy?: { healthcheckPath?: string };
    };
    expect(railway.build?.builder).toBe("DOCKERFILE");
    expect(railway.deploy?.healthcheckPath).toBe("/api/health");
  });

  it("keeps local state and secrets out of the Docker build context", async () => {
    const ignored = (await read(".dockerignore")).split(/\r?\n/);
    expect(ignored).toEqual(expect.arrayContaining([".git", "node_modules", "dist", ".env*", "coverage"]));
  });
});
