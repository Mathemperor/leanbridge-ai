import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Diagnostic only: immutable public image, no production credentials or model calls.
const image = 'ghcr.io/mathemperor/leanbridge-ai@sha256:d31d39ee589748d28fac391950d94b063d002e32749cf3e75ef043c307c02b1a';
const report = { image, startedAt: new Date().toISOString(), timeoutMs: 120000, runs: [] };
const docker = (args, options = {}) => String(execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, ...options }) ?? '').trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [
  ['core', 'import Init\nexample (n : Nat) : n + 0 = n := by rfl'],
  ['mathlib-nat', 'import Mathlib.Data.Nat.Basic\ntheorem diagnostic_nat (n : Nat) : n + 0 = n := by rfl\n#print axioms diagnostic_nat'],
  ['mathlib-real', 'import Mathlib.Data.Real.Basic\nimport Mathlib.Tactic.Linarith\ntheorem diagnostic_real (a b : ℝ) : 2*a*b ≤ a^2+b^2 := by\n  nlinarith [sq_nonneg (a-b)]\n#print axioms diagnostic_real'],
];

function resources(name) {
  const files = ['memory.current', 'memory.peak', 'memory.events', 'memory.stat', 'memory.pressure', 'io.pressure', 'cpu.stat'];
  return Object.fromEntries(files.map(file => {
    try { return [file, docker(['exec', name, 'cat', `/sys/fs/cgroup/${file}`])]; }
    catch { return [file, null]; }
  }));
}

try {
  docker(['pull', image], { timeout: 600000, stdio: ['ignore', 'inherit', 'inherit'] });
  for (const memoryBytes of [512000000, 536870912, 768000000]) {
    const name = `leanbridge-diagnose-${process.pid}-${memoryBytes}`;
    const token = randomBytes(32).toString('hex');
    const run = { memoryBytes, swapBytes: 0, cpus: 1, checks: [] };
    report.runs.push(run);
    let created = false;
    try {
      docker(['run', '--detach', '--name', name, `--memory=${memoryBytes}`, `--memory-swap=${memoryBytes}`, '--cpus=1', '--pids-limit=256',
        '--publish', '127.0.0.1::8080', '--env', 'PORT=8080', '--env', 'MODEL_PROVIDER=codex', '--env', 'LEAN_TIMEOUT_MS=120000', '--env', 'LEANBRIDGE_BACKEND_TOKEN', image],
        { env: { ...process.env, LEANBRIDGE_BACKEND_TOKEN: token } });
      created = true;
      const port = docker(['port', name, '8080/tcp']);
      assert(/^127\.0\.0\.1:\d+$/.test(port));
      const origin = `http://${port}`;
      const deadline = Date.now() + 60000;
      let healthy = false;
      while (Date.now() < deadline) {
        try { const r = await fetch(`${origin}/api/health`); if (r.ok) { healthy = true; break; } } catch { /* starting */ }
        await delay(500);
      }
      assert(healthy, 'Container health');
      run.before = resources(name);
      for (const [label, code] of cases) {
        const before = resources(name);
        const response = await fetch(`${origin}/api/proofs/manual`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ code }), signal: AbortSignal.timeout(130000),
        });
        const body = await response.json();
        const result = { label, httpStatus: response.status, status: body.status, verification: body.verification, before, after: resources(name) };
        run.checks.push(result);
        console.log(JSON.stringify({ memoryBytes, ...result }));
      }
      run.oomKilled = docker(['inspect', '--format', '{{.State.OOMKilled}}', name]) === 'true';
    } catch (error) {
      run.error = String(error.message || error).replaceAll(token, '[redacted]');
    } finally {
      if (created) docker(['rm', '--force', name]);
    }
  }
} catch (error) {
  report.error = String(error.message || error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(process.env.RUNNER_TEMP || tmpdir(), 'leanbridge-runtime-diagnosis.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`LEANBRIDGE_RUNTIME_DIAGNOSIS=${JSON.stringify(report)}`);
}
