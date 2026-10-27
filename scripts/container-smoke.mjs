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
const report = { image, sourceRevision: process.env.GITHUB_SHA || null, startedAt: new Date().toISOString(), compiler: "LeanWeb mathlib-v4.24.0", limits: { memoryBytes: 192000000, swapBytes: 0, cpus: 1 }, checks: [] };
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

async function proof(checkName, code) {
  const result = await compile(code);
  let memoryCurrentBytes = null;
  let memoryPeakBytes = null;
  try { memoryCurrentBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current'])); } catch {}
  try { memoryPeakBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak'])); } catch {}
  record(checkName, { httpStatus: result.status, status: result.body.status, verification: result.body.verification, memoryCurrentBytes, memoryPeakBytes });
  assert.equal(result.status, 200, `${checkName}: HTTP status`);
  assert.equal(result.body.status, 'verified', `${checkName}: real proof did not verify`);
  assert.equal(result.body.verification?.ok, true, `${checkName}: compiler success required`);
  assert(!/sorryAx/.test(result.body.verification?.output || ''), `${checkName}: placeholder axiom`);
}

async function compile(code) {
  const start = Date.now();
  let result = await request('/api/proofs/manual', { code });
  assert.equal(result.status, 202, 'Compilation must return an asynchronous job');
  assert(Date.now() - start < 20000, 'Submission must fit the Site proxy deadline');
  const id = result.body.id;
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  const deadline = Date.now() + 150000;
  while (!['verified', 'failed'].includes(result.body.status) && Date.now() < deadline) {
    await delay(1000);
    result = await request(`/api/proofs/${id}`);
    assert.equal(result.status, 200, 'Polling must retain the job');
  }
  return result;
}

try {
  report.imageSizeBytes = Number(docker(['image', 'inspect', '--format', '{{.Size}}', image]));
  report.imageRevision = docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
  if (process.env.GITHUB_SHA) assert.equal(report.imageRevision, process.env.GITHUB_SHA, 'Built source revision');
  docker(['run', '--detach', '--name', name, '--memory=192000000', '--memory-swap=192000000', '--cpus=1', '--pids-limit=256',
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
  assert.equal(config.body.lean?.verifier, 'leanweb');
  docker(['exec', name, 'sh', '-c', 'test ! -e /opt/elan && test ! -e /app/lean-project && ! command -v lean']);
  record('no-local-compiler', { ok: true });
  assert(config.body.codexCatalog?.models?.some(model => model.id === 'gpt-6.1-sol'), 'Model-selection catalog');
  record('codex-only-config-and-catalog', { provider: config.body.provider, lean: config.body.lean, modelCount: config.body.codexCatalog.models.length });
  const ready = await request('/api/ready');
  assert.equal(ready.status, 200, `Readiness check must succeed: ${JSON.stringify(ready.body)}`);
  assert.equal(ready.body.ok, true, 'Lean readiness must be ok');
  let memoryAfterReadyBytes = null;
  try { memoryAfterReadyBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current'])); } catch { memoryAfterReadyBytes = null; }
  record('leanweb-readiness', { httpStatus: ready.status, lean: ready.body.lean, memoryAfterReadyBytes });
  if (memoryAfterReadyBytes !== null) {
    assert(memoryAfterReadyBytes < 160_000_000, `Idle memory after /api/ready should stay below 160 MB, got ${memoryAfterReadyBytes}`);
  }
  await proof('mathlib-nat-original-regression', 'import Mathlib.Data.Nat.Basic\n\n-- The proof uses no sorry and no new axiom.\n/- A constant /- harmless nested comment -/ is only explanatory text. -/\ntheorem ci_nat_add_zero (n : Nat) : n + 0 = n := by\n  rfl\n\n#print axioms ci_nat_add_zero\n');
  await proof('full-mathlib-real-inequality', 'import Mathlib\n\ntheorem ci_real_inequality (a b : ℝ) : 2*a*b ≤ a^2+b^2 := by\n  nlinarith [sq_nonneg (a-b)]\n\n#print axioms ci_real_inequality\n');
  const invalid = await compile('example : (1 : Nat) = 2 := by rfl');
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
  try { report.memoryCurrentAfterBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current'])); } catch { report.memoryCurrentAfterBytes = null; }
  try { report.memoryPeakBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak'])); } catch { report.memoryPeakBytes = null; }
  try { report.memoryEvents = docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.events']); } catch { report.memoryEvents = null; }
  if (report.memoryPeakBytes !== null) assert(report.memoryPeakBytes < 192_000_000, 'Verification must fit the 192 MB test budget');
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error.message || error).replaceAll(token, '[redacted]');
  if (created) {
    try { report.memoryCurrentAfterBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current'])); } catch {}
    try { report.memoryPeakBytes = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak'])); } catch {}
    try { report.memoryEvents = docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.events']); } catch {}
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
