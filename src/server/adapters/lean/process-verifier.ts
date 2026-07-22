import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { VerificationResult } from "@shared/proof";
import type { LeanVerifier, VerifyOptions } from "@server/domain/ports";
import { parseLeanOutput } from "./diagnostics";

const MAX_OUTPUT_BYTES = 256 * 1024;
const LAKE_MARKERS = ["lakefile.lean", "lakefile.toml", "lakefile"];
const SAFE_ENVIRONMENT_KEYS = [
  "ELAN_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LEAN_PATH",
  "PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
] as const;

export function leanSubprocessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isLakeProject(projectPath: string): Promise<boolean> {
  const checks = await Promise.all(LAKE_MARKERS.map((marker) => exists(join(projectPath, marker))));
  return checks.some(Boolean);
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString("utf8");
}

function stopProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

export class ProcessLeanVerifier implements LeanVerifier {
  async verify(code: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    const projectPath = resolve(options.projectPath ?? process.cwd());
    const timeoutMs = options.timeoutMs ?? 30_000;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "leanbridge-"));
    const sourcePath = join(temporaryDirectory, "Main.lean");

    try {
      await writeFile(sourcePath, code, "utf8");

      const useLake = await isLakeProject(projectPath);
      const command = useLake ? (options.lakeCommand ?? "lake") : (options.leanCommand ?? "lean");
      const args = useLake ? ["env", "lean", sourcePath] : [sourcePath];
      const commandDisplay = [basename(command), ...args.map((arg) => basename(arg))].join(" ");

      return await new Promise<VerificationResult>((resolveResult) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;

        const child = spawn(command, args, {
          cwd: projectPath,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: leanSubprocessEnvironment(process.env),
        });

        const timer = setTimeout(() => {
          timedOut = true;
          stopProcess(child.pid);
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = appendBounded(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendBounded(stderr, chunk);
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const output = error.code === "ENOENT"
            ? `Lean executable not found: ${command} (${error.code})`
            : error.message;
          resolveResult({
            ok: false,
            status: error.code === "ENOENT" ? "missing" : "failed",
            command: commandDisplay,
            durationMs: Date.now() - started,
            output,
            diagnostics: parseLeanOutput(output),
          });
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const rawOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
          const output = rawOutput.replaceAll(sourcePath, "Main.lean") || (exitCode === 0 ? "Lean verification succeeded." : "Lean verification failed.");
          const ok = !timedOut && exitCode === 0;
          resolveResult({
            ok,
            status: timedOut ? "timeout" : ok ? "verified" : "failed",
            command: commandDisplay,
            durationMs: Date.now() - started,
            output: timedOut ? `Lean verification timed out after ${timeoutMs} ms.` : output,
            diagnostics: ok ? [] : parseLeanOutput(timedOut ? `Lean verification timed out after ${timeoutMs} ms.` : output),
            ...(exitCode === null ? {} : { exitCode }),
          });
        });
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
