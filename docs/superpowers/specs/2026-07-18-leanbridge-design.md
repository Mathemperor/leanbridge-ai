# LeanBridge AI — Design Specification

Date: 2026-07-18
Status: approved by the user's explicit instruction to proceed without interim approval

## 1. Product goal

LeanBridge AI converts either a photograph/scan of a handwritten mathematical proof or a LaTeX proof into Lean 4 source, runs that source against a real Lean project, and feeds compiler diagnostics back to the model for bounded automatic repair.

The MVP succeeds when a user can:

1. paste LaTeX or upload an image;
2. generate a readable Lean 4 theorem without placeholders such as `sorry` or `admit`;
3. verify it with `lake env lean` (or a configured Lean executable);
4. inspect compiler output and the repair history;
5. edit, re-verify, copy, or download the resulting `.lean` file.

## 2. Considered approaches

### A. Browser-only application

Run the entire product in the browser, possibly using a WebAssembly build of Lean. This is easy to host but is a poor fit for real mathlib projects, local imports, package versions, and direct project verification.

### B. Local full-stack workbench — selected

Use a React browser UI with a local Node service. The service keeps the OpenAI key private, invokes the Responses API, and starts Lean as a child process using argument arrays rather than a shell. This is the smallest architecture that can work with a user's actual Lean/mathlib environment.

### C. Hosted service with isolated Lean workers

Upload jobs to a hosted API and compile them in short-lived containers. This is appropriate for a later multi-user release, but it adds sandboxing, queues, storage, abuse controls, and infrastructure before the core translation loop has been evaluated.

## 3. Scope

### Included in the MVP

- Handwritten proof images in PNG, JPEG, or WebP, sent as multimodal input.
- LaTeX/plain-text proof input.
- OpenAI Responses API integration with structured output.
- Default model `gpt-5.6`, overridable by `OPENAI_MODEL`.
- Configurable Lean project directory and compiler timeout.
- Lean verification through `lake env lean <file>` when a `lakefile` is present, otherwise `lean <file>`.
- Up to three repair attempts using exact compiler diagnostics.
- Re-verification after manual code edits.
- Copy and `.lean` download actions.
- Demo provider for running the complete UI and test suite without an API key or Lean installation.
- English Lean source with a Chinese user interface.

### Deferred

- User accounts, shared projects, durable cloud history, billing, and collaboration.
- Automated theorem-library search or premise retrieval.
- Fine-tuning and reinforcement learning.
- Arbitrary shell commands or package installation from the UI.
- A hosted multi-tenant Lean sandbox.

## 4. Architecture

The application is a TypeScript monorepo-shaped single package:

- `src/client`: React/Vite interface.
- `src/server/http`: HTTP routes and validation.
- `src/server/domain`: provider-neutral orchestration and job state.
- `src/server/adapters/openai`: multimodal translation and diagnostic repair.
- `src/server/adapters/lean`: safe Lean process invocation.
- `src/shared`: request/response schemas shared by client and server.

Every dependency points inward through explicit interfaces:

- `ProofModel` accepts normalized source plus optional image and returns structured Lean output.
- `LeanVerifier` accepts Lean source and project settings and returns structured diagnostics.
- `ProofPipeline` coordinates translate → guard → verify → repair without knowing SDK or process details.
- `JobStore` records the current state and attempt history. The MVP implementation is in memory.

## 5. Data flow

1. The client validates input size/type and submits a proof job.
2. The server validates the request and returns a job identifier immediately.
3. The pipeline records `reading`, then sends text and, when supplied, an `input_image` data URL to the model.
4. Structured output contains normalized source, theorem summary, assumptions, imports, and Lean code.
5. A local guard rejects placeholders (`sorry`, `admit`) and malformed fenced output.
6. The verifier writes a unique temporary `.lean` file and invokes Lean without a shell.
7. On success, the job becomes `verified`.
8. On failure and while the repair budget remains, the pipeline sends the current code and bounded compiler output to the model, then verifies the replacement.
9. The client polls and renders stage events, attempts, code, and diagnostics.
10. Manual edits use a dedicated re-verify endpoint and do not call the model.

## 6. OpenAI request design

Use the Responses API and structured outputs. The system instruction defines the model as a Lean 4/mathlib formalization engineer and requires semantic fidelity, explicit assumptions, compilable imports, and no proof placeholders. Image submissions use one user message containing `input_text` plus `input_image`.

Translation output schema:

- `normalizedSource: string`
- `theoremSummary: string`
- `assumptions: string[]`
- `imports: string[]`
- `leanCode: string`
- `notes: string[]`

Repairs receive the prior structured context, current Lean code, and compiler diagnostics. They return the same schema so each attempt remains auditable. The application uses `reasoning.effort: high` by default because theorem formalization is quality-sensitive; this is configurable.

## 7. Lean execution and security

- Never interpolate user values into a shell command.
- Use `spawn(command, args, { shell: false })`.
- Resolve and validate the project directory before execution.
- Prefer `lake env lean` only when a Lake project marker exists.
- Write generated code to an application-owned temporary directory, not over a user file.
- Apply a wall-clock timeout and bounded output capture.
- Kill the entire spawned process on timeout where the platform permits.
- Do not expose the OpenAI key to the browser or logs.
- Limit request bodies and accepted image MIME types.
- Redact absolute temporary paths from user-facing diagnostics where practical.

This is a local single-user tool, not a hardened untrusted multi-tenant sandbox. A future hosted version must isolate every Lean process in a disposable container or microVM.

## 8. Error behavior

- Missing API key: return a clear configuration error unless demo mode is enabled.
- Invalid input/image: reject before job creation with a field-specific message.
- Model refusal or invalid structured output: mark the job failed and preserve the safe error summary.
- Lean missing: report the executable that was attempted and provide setup guidance.
- Timeout: mark the verification attempt timed out and allow manual retry.
- Compiler failure after the repair budget: retain the latest code and every attempt so the user can continue manually.
- Client/network interruption: polling is resumable for as long as the local server process remains alive.

## 9. Interface design

The interface is a proof workbench, not a generic dashboard:

- A compact header shows product identity, model/provider state, and Lean availability.
- The left rail contains source mode, upload/LaTeX input, project path, and repair controls.
- The center pane is the generated Lean editor with copy/download/re-verify actions.
- The right rail shows the five-stage pipeline and compiler diagnostics.
- A restrained indigo/cyan palette, warm neutral background, serif mathematical display type, and monospace code create a research-tool character.
- On narrow screens the three panes stack in source → code → diagnostics order.

## 10. Testing strategy

### Unit tests

- Request schema and image limits.
- Placeholder guard and code-fence cleanup.
- Lean diagnostic parsing and timeout/error mapping.
- Pipeline success, repair success, repair exhaustion, and provider failure.

### Integration tests

- HTTP job creation and polling with deterministic fake adapters.
- Manual re-verification endpoint.
- Static application fallback and health/config endpoints.

### UI tests

- Mode switching, validation, job polling, result display, and action buttons using mocked HTTP.
- Accessibility checks for labels, focusable controls, live status, and keyboard operation.

### Manual verification

- Production TypeScript build.
- Full automated test suite.
- Browser inspection at desktop and mobile widths.
- When Lean is installed, compile a small mathlib theorem through the real adapter.

## 11. Configuration

Required for real AI translation:

- `OPENAI_API_KEY`

Optional:

- `OPENAI_MODEL=gpt-5.6`
- `OPENAI_REASONING_EFFORT=high`
- `LEAN_PROJECT_PATH=/absolute/path/to/lean/project`
- `LEAN_COMMAND=lean`
- `LAKE_COMMAND=lake`
- `LEAN_TIMEOUT_MS=30000`
- `MAX_REPAIR_ATTEMPTS=3`
- `DEMO_MODE=true`
- `PORT=4310`

## 12. Acceptance criteria

- `npm test` passes without network access, API credentials, or Lean.
- `npm run build` produces client and server artifacts.
- `DEMO_MODE=true npm start` exposes a usable end-to-end application.
- A configured real provider sends image/text through Responses API structured output.
- A configured Lean project is verified with the real Lean process adapter.
- No API key is present in built client assets or server responses.
- Failed verification shows exact bounded diagnostics and repair attempts.
- Verified output can be edited, rechecked, copied, and downloaded.
