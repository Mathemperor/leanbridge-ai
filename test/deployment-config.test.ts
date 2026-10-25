import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(root, relativePath), "utf8");
}

describe("cloud deployment configuration", () => {
  it("pins the Lean and mathlib releases", async () => {
    expect((await read("lean-project/lean-toolchain")).trim()).toBe("leanprover/lean4:v4.35.0");
    await expect(read("lean-project/lakefile.toml")).resolves.toMatch(/rev\s*=\s*"v4\.35\.0"/);
    await expect(read("lean-project/LeanBridge/Basic.lean")).resolves.toContain("import Mathlib");
    const manifest = JSON.parse(await read("lean-project/lake-manifest.json")) as {
      packages: Array<{ name: string; rev: string }>;
    };
    expect(manifest.packages.find((entry) => entry.name === "mathlib")?.rev)
      .toBe("56a005855ea17e0b0958f73ec801ae140b0a1679");
  });

  it("builds a non-root cloud runtime without embedding secrets", async () => {
    const dockerfile = await read("Dockerfile");
    const entrypoint = await read("docker-entrypoint.sh");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain("ENV CLOUD_MODE=true");
    expect(dockerfile).toContain("ENV LEAN_TIMEOUT_MS=240000");
    expect(dockerfile).toContain('ENV NODE_OPTIONS="--max-old-space-size=96 --expose-gc"');
    expect(dockerfile).toContain("ENV LEAN_PROJECT_PATH=/app/lean-project");
    const startup = await read("docker-cloud-start.sh");
    expect(startup).toContain('exec gosu leanbridge /usr/local/bin/docker-entrypoint.sh "$@"');
    expect(startup).toContain('chmod 700 /data/codex');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/docker-cloud-start.sh"]');
    expect(dockerfile).toContain('@openai/codex@0.163.0');
    expect(dockerfile).toContain("docker-entrypoint.sh");
    expect(dockerfile).not.toMatch(/RUN\s+chmod\s+-R\s+a-w\s+\/app\s+\/opt\/elan/);
    expect(dockerfile).toMatch(/COPY\s+--chmod=0444\s+package\.json\s+package-lock\.json\s+\.\//);
    expect(dockerfile).toContain("FROM lean-environment AS runtime");
    expect(dockerfile).not.toMatch(/COPY[^\n]*--from=lean-environment/);
    expect(dockerfile).toContain("gosu leanbridge find /opt/elan /app/lean-project -writable -print -quit");
    expect(dockerfile).toContain("gosu leanbridge /usr/local/bin/leanbridge-lake-env env lean LeanBridge/Basic.lean");
    expect(dockerfile).not.toContain("lake update");
    expect(dockerfile).not.toMatch(/OPENAI_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/NEBIUS_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/TAVILY_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/LEANBRIDGE_BACKEND_TOKEN\s*=/);
    expect(entrypoint).toContain("unset OPENAI_API_KEY NEBIUS_API_KEY TAVILY_API_KEY LEANBRIDGE_BACKEND_TOKEN");
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
    expect(wrapper).toContain('exec "$lean_bin" -j1 -M192 "$3"');
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
