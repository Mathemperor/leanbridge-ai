# LeanBridge Cloud Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the owner-only Sites demo with a production LeanBridge flow backed by OpenAI image understanding and a real Lean 4/mathlib Docker service.

**Architecture:** The existing Sites project remains the authenticated UI and proxies `/api/*` to a token-protected Railway Docker backend. The backend reuses the Express/OpenAI pipeline, pins Lean 4.24.0 and mathlib in the image, rejects cloud-only unsafe inputs, and serializes Lean subprocesses.

**Tech Stack:** TypeScript 6, React 19, Vite 8, Express 5, OpenAI Responses API, Vitest/Supertest, Lean 4.24.0, mathlib4, Docker, Railway, OpenAI Sites.

## Global Constraints

- Production must use `DEMO_MODE=false`; missing production secrets must fail startup instead of silently selecting demo adapters.
- The OpenAI API key and backend bearer token must never enter browser assets, API responses, Git, screenshots, or logs.
- Cloud requests must not accept a user-controlled Lean project path or executable path.
- Lean must run with argument arrays and `shell: false`, a 30-second default timeout, bounded output, and temporary-file cleanup.
- The first production release remains owner-only and permits one active Lean verification at a time.
- The Lean toolchain and mathlib revision are pinned to `v4.24.0`.

---

### Task 1: Cloud runtime configuration

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/config.test.ts`
- Modify: `src/client/api.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `RuntimeConfig.cloudMode: boolean`, `RuntimeConfig.backendToken?: string`, and public `lean.mode: "demo" | "local" | "cloud"`.
- Consumes: existing `loadConfig(env)` and `toPublicConfig(config)` entry points.

- [ ] **Step 1: Write failing cloud configuration tests**

Add tests that require the backend token, fixed Lean project, and OpenAI key in cloud mode:

```ts
it("requires all production secrets in cloud mode", () => {
  expect(() => loadConfig({ CLOUD_MODE: "true" })).toThrow(/OPENAI_API_KEY/);
  expect(() => loadConfig({ CLOUD_MODE: "true", OPENAI_API_KEY: "sk-test" })).toThrow(/LEANBRIDGE_BACKEND_TOKEN/);
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
  expect(config).toMatchObject({ cloudMode: true, demoMode: false });
  expect(toPublicConfig(config).lean.mode).toBe("cloud");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- src/server/config.test.ts`

Expected: failures because `cloudMode`, `backendToken`, and cloud validation do not exist.

- [ ] **Step 3: Implement cloud configuration**

Extend `RuntimeConfig`, make cloud mode override demo mode, validate required values in this order, and expose only non-secret capability state:

```ts
const cloudMode = booleanValue(env.CLOUD_MODE);
const demoMode = cloudMode ? false : booleanValue(env.DEMO_MODE);
const apiKey = env.OPENAI_API_KEY?.trim();
const backendToken = env.LEANBRIDGE_BACKEND_TOKEN?.trim();
const leanProjectPath = env.LEAN_PROJECT_PATH?.trim();

if (!demoMode && !apiKey) throw new Error("OPENAI_API_KEY is required unless DEMO_MODE=true");
if (cloudMode && !backendToken) throw new Error("LEANBRIDGE_BACKEND_TOKEN is required in cloud mode");
if (cloudMode && !leanProjectPath) throw new Error("LEAN_PROJECT_PATH is required in cloud mode");
```

Set `lean.mode` to `"cloud"` before the existing demo/local branches and update `ClientRuntimeConfig` accordingly. Document `CLOUD_MODE` and `LEANBRIDGE_BACKEND_TOKEN` in `.env.example` with empty values.

- [ ] **Step 4: Run the focused tests and typecheck**

Run: `npm test -- src/server/config.test.ts && npm run typecheck`

Expected: config tests pass and TypeScript exits `0`.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/config.test.ts src/client/api.ts .env.example
git commit -m "feat: add strict LeanBridge cloud configuration"
```

---

### Task 2: Backend authentication and cloud request policy

**Files:**
- Create: `src/server/backend-auth.ts`
- Create: `src/server/backend-auth.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/SourcePanel.tsx`
- Modify: `src/client/App.test.tsx`

**Interfaces:**
- Produces: `backendAuth(expectedToken: string): RequestHandler` using timing-safe byte comparison.
- Extends: `CreateAppOptions` with `backendToken?: string` and `cloudMode?: boolean`.
- Consumes: `RuntimeConfig.backendToken`, `RuntimeConfig.cloudMode` from Task 1.

- [ ] **Step 1: Write failing middleware and route tests**

Cover public health, rejected unauthenticated API access, accepted bearer token, and cloud project-path rejection:

```ts
it("protects backend API routes with a bearer token", async () => {
  const app = makeApp({ backendToken: "correct-token" });
  expect((await request(app).get("/api/health")).status).toBe(200);
  expect((await request(app).get("/api/config")).status).toBe(401);
  expect((await request(app).get("/api/config").set("Authorization", "Bearer correct-token")).status).toBe(200);
});

it("rejects user-controlled project paths in cloud mode", async () => {
  const app = makeApp({ cloudMode: true });
  const response = await request(app).post("/api/proofs").send({
    mode: "latex", latex: "truth", autoRepair: true, projectPath: "/tmp/untrusted",
  });
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/工程路径/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- src/server/backend-auth.test.ts src/server/app.test.ts src/client/App.test.tsx`

Expected: middleware module missing and cloud policy assertions fail.

- [ ] **Step 3: Implement constant-time bearer authentication**

Create `backend-auth.ts` with an exact Bearer parser and `timingSafeEqual`:

```ts
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function backendAuth(expectedToken: string): RequestHandler {
  const expected = Buffer.from(expectedToken);
  return (request, response, next) => {
    const value = request.header("authorization") ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.status(401).json({ error: "后端认证失败" });
      return;
    }
    next();
  };
}
```

Mount `/api/health` before the middleware, mount authentication before all remaining `/api` routes, and reject `projectPath` when `cloudMode` is true. Pass both options from `index.ts`.

- [ ] **Step 4: Hide local-path controls in cloud mode**

Add `cloudMode={config?.lean.mode === "cloud"}` to `SourcePanel`, omit `projectPath` from requests in cloud mode, and render a read-only message `云端使用固定的 Lean 4 / mathlib 环境` instead of the path input.

- [ ] **Step 5: Run focused tests and full typecheck**

Run: `npm test -- src/server/backend-auth.test.ts src/server/app.test.ts src/client/App.test.tsx && npm run typecheck`

Expected: all focused tests pass and TypeScript exits `0`.

- [ ] **Step 6: Commit**

```bash
git add src/server/backend-auth.ts src/server/backend-auth.test.ts src/server/app.ts src/server/app.test.ts src/server/index.ts src/client/App.tsx src/client/components/SourcePanel.tsx src/client/App.test.tsx
git commit -m "feat: secure the LeanBridge cloud backend"
```

---

### Task 3: Serialized Lean verification and readiness

**Files:**
- Create: `src/server/adapters/lean/serial-verifier.ts`
- Create: `src/server/adapters/lean/serial-verifier.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Produces: `SerialLeanVerifier implements LeanVerifier`, constructed with another `LeanVerifier`.
- Produces: `GET /api/ready` authenticated route returning `{ ok: true, lean: "ready" }` only after `access(LEAN_PROJECT_PATH)` and a real verifier probe succeed.

- [ ] **Step 1: Write a failing serialization test**

Use a controlled verifier that records active calls:

```ts
it("runs only one Lean verification at a time", async () => {
  let active = 0;
  let maximum = 0;
  const inner: LeanVerifier = {
    async verify() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return verified;
    },
  };
  const verifier = new SerialLeanVerifier(inner);
  await Promise.all([verifier.verify("a", {}), verifier.verify("b", {})]);
  expect(maximum).toBe(1);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- src/server/adapters/lean/serial-verifier.test.ts`

Expected: module/class missing.

- [ ] **Step 3: Implement the queue**

Maintain a private promise tail; every `verify` waits for the prior tail and releases in `finally`. Do not add a third-party queue dependency.

- [ ] **Step 4: Add readiness behavior**

Expose `/api/ready` only in real/cloud mode. It verifies `theorem leanBridgeReady : True := by trivial` through the configured verifier and returns `503` if the result is missing, failed, or timed out. Wrap `ProcessLeanVerifier` in `SerialLeanVerifier` from `index.ts` for cloud mode.

- [ ] **Step 5: Run focused and regression tests**

Run: `npm test -- src/server/adapters/lean/serial-verifier.test.ts src/server/app.test.ts src/server/adapters/lean/process-verifier.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/lean/serial-verifier.ts src/server/adapters/lean/serial-verifier.test.ts src/server/app.ts src/server/app.test.ts src/server/index.ts
git commit -m "feat: serialize cloud Lean verification"
```

---

### Task 4: Reproducible Lean/mathlib Docker image

**Files:**
- Create: `lean-project/lean-toolchain`
- Create: `lean-project/lakefile.toml`
- Create: `lean-project/LeanBridge/Basic.lean`
- Generate: `lean-project/lake-manifest.json`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `railway.json`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: OCI image listening on provider-supplied `PORT`, with `LEAN_PROJECT_PATH=/app/lean-project` and `lake env lean` available.
- Consumes: production server from Tasks 1–3.

- [ ] **Step 1: Add the pinned Lean project**

`lean-project/lean-toolchain`:

```text
leanprover/lean4:v4.24.0
```

`lean-project/lakefile.toml`:

```toml
name = "leanbridge"
version = "0.1.0"
defaultTargets = ["LeanBridge"]

[[require]]
name = "mathlib"
git = "https://github.com/leanprover-community/mathlib4.git"
rev = "v4.24.0"

[[lean_lib]]
name = "LeanBridge"
```

`lean-project/LeanBridge/Basic.lean`:

```lean
import Mathlib

theorem leanBridgeImageReady : (1 : Nat) + 1 = 2 := by norm_num
```

- [ ] **Step 2: Generate and verify the mathlib manifest**

Run from `lean-project`: `lake update && lake exe cache get && lake env lean LeanBridge/Basic.lean`

Expected: dependencies resolve, cache downloads, and Lean exits `0`. Commit the generated `lake-manifest.json`.

- [ ] **Step 3: Add the Docker build**

Use `node:22-bookworm-slim`, install `curl git ca-certificates zstd`, install Elan and the pinned toolchain, run `npm ci && npm run build && npm prune --omit=dev`, run `lake update && lake exe cache get`, create an unprivileged `leanbridge` user, expose `4310`, and start `node dist/server/index.js`. Set production defaults with `ENV CLOUD_MODE=true DEMO_MODE=false LEAN_PROJECT_PATH=/app/lean-project` but leave secrets unset.

- [ ] **Step 4: Add Docker/Railway metadata**

`.dockerignore` must exclude `.git`, `node_modules`, `dist`, `.env`, coverage, and logs. `railway.json` must use the Dockerfile builder and `/api/health` as the health-check path. Add package scripts:

```json
"docker:build": "docker build -t leanbridge-ai:local .",
"docker:smoke": "docker run --rm --env-file .env.docker -p 4310:4310 leanbridge-ai:local"
```

- [ ] **Step 5: Build and run container verification**

Run: `docker build -t leanbridge-ai:local .`

Run the image with non-production test secrets, then assert:

```bash
curl -fsS http://127.0.0.1:4310/api/health
curl -fsS -H "Authorization: Bearer test-token" http://127.0.0.1:4310/api/ready
```

Expected: both return HTTP `200`; container logs contain no secret values.

- [ ] **Step 6: Commit**

```bash
git add lean-project Dockerfile .dockerignore railway.json package.json README.md
git commit -m "feat: package LeanBridge with Lean and mathlib"
```

---

### Task 5: Sites same-origin backend proxy

**Files:**
- Restore/Create: `.openai/hosting.json`
- Create: `sites/worker.ts`
- Create: `sites/worker.test.ts`
- Modify: `vite.config.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: same-origin `/api/*` proxy using runtime `LEANBRIDGE_BACKEND_URL` and `LEANBRIDGE_BACKEND_TOKEN`.
- Consumes: Railway backend routes from Tasks 1–4 and existing Sites project ID `appgprj_6a5baa0b8ffc8191a6316519249c875a`.

- [ ] **Step 1: Restore Sites project metadata**

Create `.openai/hosting.json` with the exact existing project ID and the build/start metadata required by the recovered Sites source. Do not create a new site and do not store environment values in this file.

- [ ] **Step 2: Write failing proxy tests**

Test URL joining, authorization replacement, body/method preservation, and unavailable backend behavior:

```ts
it("forwards an API request with the server-side bearer token", async () => {
  const outgoing = await buildBackendRequest(
    new Request("https://site.example/api/config"),
    { backendUrl: "https://backend.example", backendToken: "secret" },
  );
  expect(outgoing.url).toBe("https://backend.example/api/config");
  expect(outgoing.headers.get("authorization")).toBe("Bearer secret");
});
```

- [ ] **Step 3: Implement the bounded proxy**

Reject non-`/api/` paths, strip inbound `authorization`, `cookie`, and forwarding headers, add the backend bearer token, apply a 45-second abort timeout, preserve safe response headers, and convert network failures to JSON `503` without logging request bodies.

- [ ] **Step 4: Build and test the Sites source**

Run: `npm test -- sites/worker.test.ts && npm run build`

Expected: proxy tests pass and the Sites-compatible build completes.

- [ ] **Step 5: Commit**

```bash
git add .openai/hosting.json sites/worker.ts sites/worker.test.ts vite.config.ts package.json README.md
git commit -m "feat: proxy Sites API calls to LeanBridge backend"
```

---

### Task 6: Production deployment and end-to-end verification

**Files:**
- Modify: `.openai/hosting.json` only if the Sites tooling adds non-secret deployment metadata.
- Modify: `README.md`

**Interfaces:**
- Consumes: tested Railway image, existing owner-only Sites project, OpenAI key supplied outside Git, and one generated shared backend token.
- Produces: deployed owner-only production URL and recorded operational steps.

- [ ] **Step 1: Run the complete local verification gate**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: zero failed tests, successful build, and no whitespace errors.

- [ ] **Step 2: Deploy the Docker backend**

Push the tested commit to the repository connected to Railway. Create one Railway service from the Dockerfile, set `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, and a generated `LEANBRIDGE_BACKEND_TOKEN`, then generate its HTTPS domain. Do not paste secrets into Git or build arguments.

- [ ] **Step 3: Verify real backend behavior**

Check `/api/health`, authenticated `/api/ready`, one valid Lean proof, and one invalid edited proof. Submit two distinct proof images and verify their `normalizedSource` values differ.

- [ ] **Step 4: Configure Sites runtime variables**

Store `LEANBRIDGE_BACKEND_URL` and secret `LEANBRIDGE_BACKEND_TOKEN` through Sites environment-variable management. Keep the current custom owner-only access policy unchanged.

- [ ] **Step 5: Save and deploy a new Sites version**

Push the exact source state, save a Sites version referencing that commit SHA, and use the owner-only production deployment path. Poll deployment status until it succeeds or returns a terminal failure.

- [ ] **Step 6: Run production end-to-end acceptance**

Open the production Sites URL, confirm the header reports `OpenAI 已连接` and real cloud Lean, upload a handwritten proof image, verify Lean code is generated, edit it into an invalid proof, and confirm Lean rejects it with diagnostics. Inspect Worker/backend logs for secret leakage and unexpected `401`, `413`, `503`, or timeout events.

- [ ] **Step 7: Record deployment and commit documentation**

Document the production URL, Railway health URL, pinned Lean/mathlib version, required secret names, rollback procedure, and known in-memory job limitation without recording secret values.

```bash
git add README.md .openai/hosting.json
git commit -m "docs: record LeanBridge production deployment"
```

