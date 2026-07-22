# LeanBridge AI — Cloud Production Design

Date: 2026-07-18
Status: architecture approved by the user

## 1. Goal

Replace the deterministic cloud demo with an owner-only production deployment that:

1. reads handwritten mathematical proofs from PNG, JPEG, or WebP images;
2. converts image or LaTeX input into structured Lean 4 source through OpenAI;
3. verifies the generated source with real Lean 4 and mathlib;
4. returns compiler diagnostics and performs bounded repair attempts;
5. keeps API keys and backend credentials out of browser assets and logs.

The existing Sites URL and user interface remain the primary entry point.

## 2. Current state and root cause

The current Sites project has one deployed version and zero production environment variables. The deployed application therefore uses a deterministic demonstration model. Local `.env` files are not production Sites configuration, and the Sites Worker runtime cannot execute the native Lean process installed in a separate development workspace.

## 3. Considered approaches

### A. Browser-only Lean/WebAssembly

Keep all logic in Sites and run Lean in the browser. This avoids a second hosting provider but makes current mathlib support, memory use, startup time, and isolation materially harder. It is not selected for the production MVP.

### B. Sites plus a dedicated Docker backend — selected

Keep the authenticated Sites UI and same-origin API surface. A thin Sites Worker proxy forwards API requests to a token-protected Docker service. The Docker service runs the existing Node pipeline, OpenAI multimodal requests, Lean 4, and a pinned mathlib project.

Railway is the default deployment target because it can build from a Dockerfile, inject service variables, and expose a generated HTTPS domain. The Docker image remains provider-neutral so it can later move to Fly.io, Render, or another OCI-compatible host.

### C. Host the entire application on the Docker provider

Serve both UI and API directly from Railway and retire Sites. This is simpler operationally but discards the existing Sites identity gate and URL. It remains a fallback if Sites proxy constraints block production traffic.

## 4. Architecture

### Sites application

- Serves the React/Vite interface.
- Preserves the existing owner-only Sign in with ChatGPT access policy.
- Exposes same-origin `/api/*` proxy routes.
- Reads `LEANBRIDGE_BACKEND_URL` and secret `LEANBRIDGE_BACKEND_TOKEN` only in the Worker runtime.
- Never receives or exposes the OpenAI API key in browser JavaScript.
- Proxies status codes and bounded response bodies without logging uploaded images or authorization headers.

### Docker backend

- Runs the existing Express API and proof pipeline.
- Uses `OpenAIProofModel` for image and text translation.
- Uses `ProcessLeanVerifier` against a pinned Lean/mathlib project baked into the image.
- Requires `Authorization: Bearer <LEANBRIDGE_BACKEND_TOKEN>` for every route except `/api/health`.
- Stores jobs in memory for the first production version; restarts may clear job history.
- Uses one Lean verification process at a time initially to bound memory use.
- Applies request-size, compiler-output, repair-count, and wall-clock limits.

### Lean/mathlib image

- Pins the Lean toolchain in `lean-toolchain`.
- Pins mathlib in `lakefile.toml` and `lake-manifest.json`.
- Downloads the matching mathlib cache during image construction.
- Runs generated source through `lake env lean` without a shell.
- Uses a unique temporary directory for each verification and deletes it afterward.
- Runs as a non-root user with no writable application source directory.

## 5. Request flow

1. The authenticated user uploads an image or submits LaTeX to the Sites UI.
2. The browser posts to same-origin `/api/proofs`.
3. The Sites proxy adds the backend bearer token and forwards the request over HTTPS.
4. The backend validates MIME type, decoded image size, and request schema.
5. OpenAI receives text plus `input_image` for image requests and returns structured translation output.
6. The backend rejects proof placeholders such as `sorry` and `admit`.
7. Lean verifies the generated source in the pinned mathlib project.
8. Compiler failures are returned to the model for at most the configured repair count.
9. The browser polls through the same Sites proxy and renders attempts, code, and diagnostics.

## 6. Configuration and secrets

### Railway backend variables

- `DEMO_MODE=false`
- `OPENAI_API_KEY` — secret, supplied by the user through Railway's variable UI
- `OPENAI_MODEL` — production model identifier
- `OPENAI_REASONING_EFFORT=high`
- `LEANBRIDGE_BACKEND_TOKEN` — random secret shared only with Sites
- `LEAN_PROJECT_PATH=/app/lean-project`
- `LEAN_COMMAND=lean`
- `LAKE_COMMAND=lake`
- `LEAN_TIMEOUT_MS=30000`
- `MAX_REPAIR_ATTEMPTS=3`
- `PORT` — supplied by the hosting provider

### Sites production variables

- `LEANBRIDGE_BACKEND_URL` — Railway HTTPS origin
- `LEANBRIDGE_BACKEND_TOKEN` — secret, equal to the Railway value

No secret is committed to Git, `.openai/hosting.json`, client code, screenshots, or test fixtures.

## 7. Security and abuse controls

- Keep the existing Sites project owner-only during the first production release.
- Require the shared bearer token at the Docker boundary.
- Reject unsupported MIME types and decoded images over the configured limit.
- Never accept a shell command, arbitrary executable path, or user-controlled project path in cloud mode.
- Disable the client project-path control in cloud mode.
- Use `spawn` with an argument array and `shell: false`.
- Kill the Lean process group on timeout.
- Bound stdout/stderr capture and redact temporary paths.
- Do not log request bodies, Base64 images, OpenAI keys, or bearer tokens.
- Add a small per-user/per-IP job rate limit before broadening access beyond the owner.

## 8. Failure behavior

- Missing OpenAI key: backend fails readiness with a clear configuration message; it never silently falls back to demo mode in production.
- Unreachable backend: Sites returns `503` with a retryable user-facing message.
- Invalid or oversized image: return `400`/`413` before model invocation.
- OpenAI refusal or invalid structured output: retain a safe summary and mark the job failed.
- Lean timeout or compiler failure: retain diagnostics and the latest editable Lean source.
- Backend restart: in-flight/in-memory jobs may disappear and the UI offers resubmission.

## 9. Deployment sequence

1. Add cloud-mode tests, backend authentication, health/readiness, and provider-safe configuration.
2. Add the pinned mathlib project, Dockerfile, `.dockerignore`, and Railway deployment configuration.
3. Build and run the Docker image locally; verify one valid and one invalid theorem.
4. Push the exact tested source state to the deployment repository.
5. Create the Railway service from the Dockerfile and set its secrets.
6. Verify backend health, real image transcription, Lean success, and Lean rejection.
7. Add the Sites proxy and production environment variables.
8. Save and deploy a new owner-only Sites version.
9. Run an end-to-end browser test through the production Sites URL.

## 10. Testing strategy

### Automated

- Existing unit and UI tests remain green.
- Authentication middleware accepts the correct token and rejects missing/incorrect tokens.
- Cloud configuration cannot enable demo fallback.
- Proxy tests cover success, backend timeout, `413`, and `503` behavior.
- Docker health check verifies the Node service and Lean executable.

### Container integration

- `lean --version` and `lake --version` succeed inside the final image.
- A correct theorem verifies with exit code `0`.
- A false theorem is rejected with compiler diagnostics.
- A timeout fixture terminates the process and frees its temporary directory.

### Production acceptance

- The Sites header reports OpenAI and real Lean, never demo mode.
- Two different proof images produce different normalized transcriptions.
- A valid generated proof is verified by Lean.
- An invalid edited proof is rejected by Lean.
- No secret appears in browser network responses, built assets, or logs.
- The production URL remains accessible only to the existing owner account.

## 11. External prerequisites

Implementation can prepare and verify all source and container artifacts locally. Final production activation additionally requires:

- an OpenAI API key with API billing enabled;
- a Railway account/project authorized to deploy the Docker service;
- permission to store the shared backend token as a Sites secret.

Railway deployment references:

- <https://docs.railway.com/builds/dockerfiles>
- <https://docs.railway.com/variables>
- <https://docs.railway.com/guides/docker-compose>

