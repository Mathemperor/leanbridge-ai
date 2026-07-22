# LeanBridge MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local AI workbench that converts handwritten-image or LaTeX proofs to Lean 4, verifies them in a real Lean project, and automatically repairs compiler failures.

**Architecture:** A Vite/React client submits asynchronous jobs to an Express server. A provider-neutral pipeline coordinates an OpenAI structured-output adapter and a shell-free Lean process adapter, storing bounded job history in memory and exposing polling plus manual re-verification endpoints.

**Tech Stack:** Node.js 20+, TypeScript, React 19, Vite, Express, Zod, OpenAI JavaScript SDK, Vitest, Testing Library, Supertest.

## Global Constraints

- Keep `OPENAI_API_KEY` exclusively in the server process.
- Default to `OPENAI_MODEL=gpt-5.6` and `OPENAI_REASONING_EFFORT=high`.
- Accept PNG, JPEG, or WebP images with a 10 MiB decoded-size limit.
- Invoke Lean with `spawn(..., { shell: false })` and a 30-second default timeout.
- Attempt at most three model repairs by default.
- Reject generated code containing `sorry` or `admit`.
- The automated suite must run without an API key, Lean, Docker, or network access.
- The UI copy is Chinese; generated Lean identifiers and comments are English.

---

### Task 1: Project foundation and shared contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `index.html`
- Create: `src/shared/proof.ts`
- Create: `src/shared/proof.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `ProofRequest`, `ProofJob`, `Translation`, `VerificationResult`, `proofRequestSchema`, `sanitizeLeanCode`.

- [ ] **Step 1: Add package scripts and strict TypeScript/Vitest/Vite configuration**

Use scripts `dev`, `dev:server`, `build`, `start`, `test`, and `typecheck`; configure ESM and Node 20+.

- [ ] **Step 2: Write failing schema and guard tests**

```ts
it("requires source for the selected mode", () => {
  expect(proofRequestSchema.safeParse({ mode: "latex", latex: "" }).success).toBe(false);
});

it("rejects proof placeholders", () => {
  expect(() => sanitizeLeanCode("theorem t : True := by sorry")).toThrow(/placeholder/i);
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `npm test -- src/shared/proof.test.ts`
Expected: FAIL because shared contracts do not exist.

- [ ] **Step 4: Implement discriminated request schemas and domain types**

```ts
export const proofRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("latex"), latex: z.string().trim().min(1).max(50_000), projectPath: z.string().optional(), autoRepair: z.boolean().default(true) }),
  z.object({ mode: z.literal("image"), imageDataUrl: imageDataUrlSchema, context: z.string().max(10_000).optional(), projectPath: z.string().optional(), autoRepair: z.boolean().default(true) }),
]);

export function sanitizeLeanCode(value: string): string {
  const code = value.trim().replace(/^```(?:lean4?|text)?\s*/i, "").replace(/\s*```$/, "");
  if (/\b(?:sorry|admit)\b/.test(code)) throw new Error("Generated Lean contains a proof placeholder");
  return code;
}
```

- [ ] **Step 5: Run tests and type checking**

Run: `npm test -- src/shared/proof.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig*.json vite.config.ts vitest.config.ts index.html src/shared
git commit -m "feat: establish LeanBridge contracts"
```

### Task 2: Lean process adapter

**Files:**
- Create: `src/server/domain/ports.ts`
- Create: `src/server/adapters/lean/process-verifier.ts`
- Create: `src/server/adapters/lean/process-verifier.test.ts`
- Create: `src/server/adapters/lean/diagnostics.ts`
- Create: `src/server/adapters/lean/diagnostics.test.ts`

**Interfaces:**
- Consumes: `VerificationResult` from Task 1.
- Produces: `LeanVerifier.verify(code, options): Promise<VerificationResult>` and `ProcessLeanVerifier`.

- [ ] **Step 1: Write failing diagnostic and fake-process tests**

```ts
it("maps a Lean error to a source location", () => {
  const result = parseLeanOutput("Main.lean:4:12: error: unsolved goals\n⊢ False");
  expect(result[0]).toMatchObject({ line: 4, column: 12, severity: "error", message: "unsolved goals\n⊢ False" });
});

it("passes the source filename as an argv item", async () => {
  const result = await verifier.verify("example : True := by trivial", { projectPath: fixture, command: fakeLean });
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- src/server/adapters/lean`
Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the port and process adapter**

```ts
export interface LeanVerifier {
  verify(code: string, options: VerifyOptions): Promise<VerificationResult>;
}

const child = spawn(command, args, {
  cwd: projectPath,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Select `lake env lean <temporary-file>` when `lakefile.lean`, `lakefile.toml`, or `lakefile` exists; otherwise select `<lean-command> <temporary-file>`. Cap combined output at 256 KiB, enforce the timeout, clean the temporary directory in `finally`, and return structured `missing`, `timeout`, `failed`, or `verified` states.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/server/adapters/lean`
Expected: PASS, including missing-binary and timeout fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/server/domain/ports.ts src/server/adapters/lean
git commit -m "feat: verify generated proofs with Lean"
```

### Task 3: OpenAI and demo proof-model adapters

**Files:**
- Create: `src/server/adapters/model/prompt.ts`
- Create: `src/server/adapters/model/openai-proof-model.ts`
- Create: `src/server/adapters/model/openai-proof-model.test.ts`
- Create: `src/server/adapters/model/demo-proof-model.ts`
- Create: `src/server/adapters/model/demo-proof-model.test.ts`

**Interfaces:**
- Consumes: `ProofModel`, `ProofSource`, `Translation`, and `RepairContext` from Tasks 1–2.
- Produces: `OpenAIProofModel` and `DemoProofModel` implementations.

- [ ] **Step 1: Define failing tests for multimodal and repair requests**

```ts
it("sends handwriting as an input_image", async () => {
  await model.translate({ mode: "image", imageDataUrl: tinyPng, context: "algebra" });
  expect(parse).toHaveBeenCalledWith(expect.objectContaining({
    input: [expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: "input_image" })]) })],
  }));
});

it("includes compiler diagnostics in a repair request", async () => {
  await model.repair({ translation, diagnostics: "Main.lean:2:1: error: unknown identifier" });
  expect(JSON.stringify(parse.mock.calls[0][0])).toContain("unknown identifier");
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `npm test -- src/server/adapters/model`
Expected: FAIL because model adapters are missing.

- [ ] **Step 3: Implement a Zod structured-output schema and OpenAI adapter**

```ts
const response = await client.responses.parse({
  model: config.model,
  reasoning: { effort: config.reasoningEffort },
  input,
  text: { format: zodTextFormat(translationSchema, "lean_translation") },
});
if (!response.output_parsed) throw new Error("The model returned no structured translation");
return { ...response.output_parsed, leanCode: sanitizeLeanCode(response.output_parsed.leanCode) };
```

The prompt must require Lean 4/mathlib syntax, semantic fidelity, explicit assumptions, minimal imports, no `sorry`/`admit`, and output that is ready to compile.

- [ ] **Step 4: Implement a deterministic demo adapter**

Return a valid `Nat` addition theorem for text input and a labelled mock transcription for image input. Repairs remove an injected `simpa` error when requested by tests.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- src/server/adapters/model`
Expected: PASS without making network calls.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/model src/server/domain/ports.ts
git commit -m "feat: translate proofs with structured AI output"
```

### Task 4: Translation-verification-repair pipeline

**Files:**
- Create: `src/server/domain/proof-pipeline.ts`
- Create: `src/server/domain/proof-pipeline.test.ts`
- Create: `src/server/domain/job-store.ts`
- Create: `src/server/domain/job-store.test.ts`

**Interfaces:**
- Consumes: `ProofModel`, `LeanVerifier`, and shared job types.
- Produces: `ProofPipeline.start(request): ProofJob`, `ProofPipeline.run(id): Promise<void>`, `ProofPipeline.reverify(id, code): Promise<ProofJob>`, and `InMemoryJobStore`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
it("repairs once and finishes verified", async () => {
  verifier.verify.mockResolvedValueOnce(failed).mockResolvedValueOnce(verified);
  await pipeline.run(job.id);
  expect(store.get(job.id)?.status).toBe("verified");
  expect(model.repair).toHaveBeenCalledTimes(1);
});

it("preserves the last code when repairs are exhausted", async () => {
  verifier.verify.mockResolvedValue(failed);
  await pipeline.run(job.id);
  expect(store.get(job.id)).toMatchObject({ status: "failed", translation: expect.any(Object) });
});
```

- [ ] **Step 2: Confirm failure**

Run: `npm test -- src/server/domain`
Expected: FAIL because the state machine is missing.

- [ ] **Step 3: Implement bounded orchestration and immutable event appends**

```ts
for (let attempt = 0; attempt <= repairBudget; attempt += 1) {
  const verification = await verifier.verify(translation.leanCode, verifyOptions);
  store.recordVerification(id, verification, attempt);
  if (verification.ok) return store.finish(id, "verified");
  if (!request.autoRepair || attempt === repairBudget) return store.finish(id, "failed");
  translation = await model.repair({ translation, diagnostics: verification.output });
  store.recordTranslation(id, translation, attempt + 1);
}
```

Catch provider and verifier exceptions at the pipeline boundary, convert them to safe job errors, and retain prior attempts.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/server/domain`
Expected: PASS for success, repair, exhaustion, manual reverify, and model failure.

- [ ] **Step 5: Commit**

```bash
git add src/server/domain
git commit -m "feat: close the AI to Lean verification loop"
```

### Task 5: HTTP service and runtime composition

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/app.ts`
- Create: `src/server/app.test.ts`
- Create: `src/server/index.ts`
- Create: `.env.example`

**Interfaces:**
- Consumes: domain pipeline and concrete adapters.
- Produces: `createApp(dependencies)`, `/api/health`, `/api/config`, `/api/proofs`, `/api/proofs/:id`, `/api/proofs/:id/verify`.

- [ ] **Step 1: Write failing Supertest API tests**

```ts
it("creates an asynchronous proof job", async () => {
  const response = await request(app).post("/api/proofs").send({ mode: "latex", latex: "\\begin{proof} trivial \\end{proof}", autoRepair: true });
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ id: expect.any(String), status: "queued" });
});

it("does not expose the API key", async () => {
  const response = await request(app).get("/api/config");
  expect(JSON.stringify(response.body)).not.toContain("sk-");
});
```

- [ ] **Step 2: Confirm failure**

Run: `npm test -- src/server/app.test.ts`
Expected: FAIL because the HTTP app is missing.

- [ ] **Step 3: Implement validated routes and composition**

Return `202` from creation, schedule `pipeline.run(id)` with `setImmediate`, use `404` for unknown jobs and `400` for schema failures, cap JSON bodies at 15 MiB, and serve built client assets in production.

- [ ] **Step 4: Add runtime adapter selection**

Use `DemoProofModel` and a deterministic demo verifier when `DEMO_MODE=true`; otherwise require `OPENAI_API_KEY`, create `OpenAIProofModel`, and create `ProcessLeanVerifier`.

- [ ] **Step 5: Run API tests and type checking**

Run: `npm test -- src/server/app.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server .env.example
git commit -m "feat: expose proof jobs over HTTP"
```

### Task 6: Proof workbench interface

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/App.test.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/styles.css`
- Create: `src/client/components/SourcePanel.tsx`
- Create: `src/client/components/LeanEditor.tsx`
- Create: `src/client/components/VerificationPanel.tsx`

**Interfaces:**
- Consumes: HTTP API and shared proof types.
- Produces: responsive Chinese workbench UI.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it("submits LaTeX and displays verified Lean", async () => {
  render(<App api={fakeApi} />);
  await userEvent.type(screen.getByLabelText("LaTeX 证明"), "proof text");
  await userEvent.click(screen.getByRole("button", { name: "生成并验证" }));
  expect(await screen.findByText("Lean 验证通过")).toBeInTheDocument();
  expect(screen.getByLabelText("Lean 4 代码")).toHaveValue(expect.stringContaining("theorem"));
});
```

- [ ] **Step 2: Confirm failure**

Run: `npm test -- src/client/App.test.tsx`
Expected: FAIL because the client is missing.

- [ ] **Step 3: Implement source input and polling**

Support text/image tabs, drag-and-drop plus file picker, local preview, 10 MiB validation, project path, auto-repair toggle, create-job submission, and polling with abort cleanup.

- [ ] **Step 4: Implement editor and verification history**

Provide editable code, copy, `.lean` download, manual re-verify, compiler output, attempt cards, and an `aria-live="polite"` status region.

- [ ] **Step 5: Implement responsive research-tool visual system**

Use CSS custom properties, a three-column desktop grid, stacked mobile layout, visible focus states, reduced-motion handling, and semantic buttons/labels. Avoid external font or image dependencies.

- [ ] **Step 6: Run UI tests**

Run: `npm test -- src/client/App.test.tsx`
Expected: PASS for mode switching, validation, polling, verified output, and manual reverify.

- [ ] **Step 7: Commit**

```bash
git add src/client
git commit -m "feat: add the LeanBridge proof workbench"
```

### Task 7: Documentation and final acceptance

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `test/fixtures/fake-lean.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: all implemented components.
- Produces: installation/run guide, architecture notes, and final verified package.

- [ ] **Step 1: Add a deterministic fake Lean fixture and smoke test script**

The fixture exits zero for code containing `by trivial` and emits a Lean-shaped diagnostic plus exit code one otherwise. Use it to exercise the production process adapter without Lean installed.

- [ ] **Step 2: Write setup and use documentation**

Document prerequisites, `npm install`, demo mode, real `OPENAI_API_KEY`, `LEAN_PROJECT_PATH`, Lean/mathlib setup via elan/Lake, privacy boundary, supported inputs, and troubleshooting for missing executables and timeouts.

- [ ] **Step 3: Run the complete verification suite**

Run: `npm test`
Expected: all tests PASS.

Run: `npm run typecheck`
Expected: exit 0 with no diagnostics.

Run: `npm run build`
Expected: client and server builds complete and `dist/client/index.html` plus `dist/server/index.js` exist.

- [ ] **Step 4: Start production demo and inspect endpoints**

Run: `DEMO_MODE=true PORT=4310 npm start`
Expected: `/api/health` returns `200`, `/api/config` reports demo provider, and the main route renders the complete workbench.

- [ ] **Step 5: Scan for secret leakage and placeholders**

Run: `rg -n 'OPENAI_API_KEY|sk-[A-Za-z0-9]' dist/client && exit 1 || true`
Expected: no matches.

Run: `rg -n '\b(sorry|admit)\b' src --glob '!*.test.ts' --glob '!*.test.tsx'`
Expected: matches only in the intentional placeholder guard/prompt text, never in generated Lean fixtures.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/architecture.md test package.json package-lock.json
git commit -m "docs: finish LeanBridge MVP handoff"
```
