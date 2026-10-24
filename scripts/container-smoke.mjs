import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.argv[2];
assert(image && /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]+$/.test(image), 'Pass the built image reference');
const name = `leanbridge-smoke-${process.pid}-${randomBytes(4).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const evidencePath = join(process.env.RUNNER_TEMP || tmpdir(), 'leanbridge-container-smoke.json');
const report = { image, sourceRevision: process.env.GITHUB_SHA || null, startedAt: new Date().toISOString(), limits: { memoryMiB: 512, swapMiB: 0, cpus: 1 }, checks: [] };
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 512 * 1024, ...options }).trim();
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let created = false;
let origin;

async function request(path, body, authenticated = true) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, body: await response.json() };
}

function record(name, data) {
  report.checks.push({ name, ...data });
  console.log(JSON.stringify({ check: name, ...data }));
}

async function proof(name, code) {
  const result = await request('/api/proofs/manual', { code });
  record(name, { httpStatus: result.status, status: result.body.status, verification: result.body.verification });
  assert.equal(result.status, 200, `${name}: HTTP status`);
  assert.equal(result.body.status, 'verified', `${name}: real proof did not verify`);
  assert.equal(result.body.verification?.ok, true, `${name}: compiler success required`);
  assert(!/sorryAx/.test(result.body.verification?.output || ''), `${name}: placeholder axiom`);
}

try {
  report.imageSizeBytes = Number(docker(['image', 'inspect', '--format', '{{.Size}}', image]));
  report.imageRevision = docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
  if (process.env.GITHUB_SHA) assert.equal(report.imageRevision, process.env.GITHUB_SHA, 'Built source revision');
  docker(['run', '--detach', '--name', name, '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=256',
    '--publish', '127.0.0.1::8080', '--env', 'PORT=8080', '--env', 'MODEL_PROVIDER=codex', '--env', 'CLOUD_MODE=true',
    '--env', 'CODEX_MODEL=gpt-6-astra', '--env', 'CODEX_REASONING_EFFORT=high', '--env', 'LEANBRIDGE_BACKEND_TOKEN', image],
  { env: { ...process.env, LEANBRIDGE_BACKEND_TOKEN: token } });
  created = true;
  const binding = docker(['port', name, '8080/tcp']);
  assert(/^127\.0\.0\.1:\d+$/.test(binding), 'Loopback-only ephemeral port');
  origin = `http://${binding}`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const result = await request('/api/health', undefined, false);
      if (result.status === 200 && result.body.ok === true) { healthy = true; break; }
    } catch { /* Startup is asynchronous. */ }
    await delay(1000);
  }
  assert(healthy, 'Container must become healthy');
  record('public-health', { ok: true });
  const denied = await request('/api/config', undefined, false);
  assert.equal(denied.status, 401, 'Anonymous protected endpoint must reject');
  record('anonymous-protected-endpoint', { httpStatus: denied.status });
  const config = await request('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.provider, 'codex');
  assert.equal(config.body.lean?.mode, 'cloud');
  assert(config.body.codexCatalog?.models?.some(model => model.id === 'gpt-6.1-sol'), 'Model-selection catalog');
  record('codex-only-config-and-catalog', { provider: config.body.provider, lean: config.body.lean, modelCount: config.body.codexCatalog.models.length });
  await proof('mathlib-nat-original-regression', 'import Mathlib.Data.Nat.Basic\n\ntheorem ci_nat_add_zero (n : Nat) : n + 0 = n := by\n  rfl\n\n#print axioms ci_nat_add_zero\n');
  await proof('mathlib-real-inequality', 'import Mathlib.Data.Real.Basic\nimport Mathlib.Tactic.Linarith\n\ntheorem ci_real_inequality (a b : ℝ) : 2*a*b ≤ a^2+b^2 := by\n  nlinarith [sq_nonneg (a-b)]\n\n#print axioms ci_real_inequality\n');
  const invalid = await request('/api/proofs/manual', { code: 'example : (1 : Nat) = 2 := by rfl' });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.status, 'failed');
  assert.equal(invalid.body.verification?.ok, false);
  assert(/type mismatch|tactic.*failed|not definitionally equal|unsolved goals/i.test(invalid.body.verification?.output || ''), 'False proof must fail with Lean diagnostics');
  record('false-proof-rejected', { httpStatus: invalid.status, verification: invalid.body.verification });
  const placeholder = await request('/api/proofs/manual', { code: 'example : False := by sorry' });
  assert.equal(placeholder.status, 400, 'sorry must be rejected');
  record('sorry-rejected', { httpStatus: placeholder.status });
  report.oomKilled = docker(['inspect', '--format', '{{.State.OOMKilled}}', name]) === 'true';
  assert.equal(report.oomKilled, false);
  try { report.memoryPeakBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak'])); } catch { report.memoryPeakBytes = null; }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error.message || error).replaceAll(token, '[redacted]');
  if (created) {
    try { report.runtimeLogs = docker(['logs', '--tail', '25', name]).replaceAll(token, '[redacted]'); } catch { /* Keep original failure. */ }
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (created) {
    try { docker(['rm', '--force', name]); } catch { process.exitCode = 1; report.cleanupFailed = true; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n');
  console.log(`LEANBRIDGE_SMOKE_RESULT=${JSON.stringify(report)}`);
}
