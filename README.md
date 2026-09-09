# LeanBridge AI

**AI proposes the proof. Lean decides whether it is valid.**

LeanBridge AI is a proof-formalization workbench for turning informal mathematics into executable Lean 4 proofs. On the 2026 hackathon branch, **NVIDIA Nemotron runs through Nebius Token Factory** to generate Lean code and to repair failed proofs using exact compiler diagnostics from a real Lean/mathlib environment.

This branch is being prepared for the **Nebius × NVIDIA Global AI Hackathon — Coding and Agentic Engineering Track**.

## Why it matters

LLMs can produce convincing mathematical text while still making subtle logical or formal mistakes. LeanBridge adds a deterministic correctness boundary:

1. A user submits a natural-language or LaTeX proof.
2. NVIDIA Nemotron generates a Lean 4 formalization through Nebius Token Factory.
3. The backend compiles the result with real Lean 4 + mathlib.
4. If compilation fails, LeanBridge sends bounded compiler diagnostics back to Nemotron.
5. Nemotron repairs the proof within a configurable attempt budget.
6. The UI preserves the generated Lean source, verification result, and repair trajectory.

The language model is a proposer; the Lean kernel is the verifier.

## Hackathon technology

### Nebius Token Factory

The dedicated adapter is in:

`src/server/adapters/model/nebius-proof-model.ts`

It makes runtime calls to the OpenAI-compatible Nebius Token Factory API for both initial proof generation and compiler-diagnostic repair.

Default endpoint:

```text
https://api.tokenfactory.us-central1.nebius.com/v1/
```

### NVIDIA Nemotron

Default hackathon model:

```text
nvidia/nemotron-3-super-120b-a12b
```

The active provider and model are exposed in the product UI so a judge can see when the live Nebius/Nemotron path is running.

### Lean 4 + mathlib

The production Docker image pins Lean 4 and mathlib to `v4.24.0`. Generated code is compiled in an isolated temporary directory. The project rejects `sorry`, `admit`, and several compile-time execution escape hatches before verification.

## Significant 2026 hackathon updates

LeanBridge AI existed before the submission period. The hackathon branch adds substantial new work rather than presenting the pre-existing product as newly created:

- dedicated Nebius Token Factory provider;
- NVIDIA Nemotron as a runtime proof-generation and repair engine;
- provider-selectable architecture (`openai` or `nebius`);
- Nebius credential handling through the production one-time secret-file boundary;
- UI visibility for the active Nebius/Nemotron runtime;
- provider/configuration/deployment regression tests;
- hackathon-specific CI for tests, typechecking, and production builds;
- submission and demo evidence documentation.

See `docs/hackathon-nebius-nvidia-2026.md` for the dated upgrade log.

## Quick start — deterministic demo mode

Requirements:

- Node.js **22.12 or newer**
- npm

```bash
npm install
cp .env.example .env
npm run dev
```

`.env.example` defaults to `DEMO_MODE=true`, which exercises the full UI without an external model API key or Lean installation. Demo mode is useful for UI development only; it does **not** satisfy the hackathon runtime requirement.

Production build:

```bash
npm run build
DEMO_MODE=true npm start
```

The app listens on `http://localhost:4310` by default.

## Run with Nebius Token Factory + real Lean

Create `.env` from `.env.example` and set:

```dotenv
DEMO_MODE=false
MODEL_PROVIDER=nebius
NEBIUS_API_KEY=your_server_side_token_factory_key
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
NEBIUS_BASE_URL=https://api.tokenfactory.us-central1.nebius.com/v1/
LEAN_PROJECT_PATH=/absolute/path/to/a/mathlib/project
LEAN_COMMAND=lean
LAKE_COMMAND=lake
LEAN_TIMEOUT_MS=30000
MAX_REPAIR_ATTEMPTS=3
PORT=4310
```

Then run:

```bash
npm run dev
```

The current default Nemotron route is text-only. Handwritten-image input remains available through the existing OpenAI provider until a compatible NVIDIA vision route is added.

## Docker / cloud deployment

The root `Dockerfile` builds a non-root production image containing pinned Lean 4 and mathlib. Cloud mode refuses to start if required credentials, the backend token, or the fixed Lean project are missing.

Example environment for the Nebius-backed container:

```dotenv
MODEL_PROVIDER=nebius
NEBIUS_API_KEY=your_server_side_token_factory_key
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
LEANBRIDGE_BACKEND_TOKEN=generate_a_long_random_secret
```

Build and smoke-test locally:

```bash
cp .env.docker.example .env.docker
# fill in the server-side secrets in .env.docker
npm run docker:build
npm run docker:smoke
```

Public health check:

```bash
curl -fsS http://127.0.0.1:4310/api/health
```

Authenticated Lean readiness probe:

```bash
curl -fsS \
  -H "Authorization: Bearer YOUR_BACKEND_TOKEN" \
  http://127.0.0.1:4310/api/ready
```

`railway.json` is configured to build the Dockerfile and use `/api/health` as the service health endpoint.

## Verification loop

```text
Informal proof
    ↓
Nebius Token Factory / NVIDIA Nemotron
    ↓
Lean 4 source
    ↓
real Lean + mathlib compiler
    ├── success → verified proof
    └── failure → bounded diagnostics → Nemotron repair → compile again
```

Manual edits can be re-verified without making another model call.

## Security boundaries

- Provider API keys remain server-side and are never included in the browser bundle.
- Docker startup moves provider keys and the backend token into a temporary secret file, unsets the raw environment variables, and removes the file after Node reads it.
- Lean subprocesses receive an allowlisted environment rather than inheriting model credentials.
- Child processes are invoked with `shell: false`.
- Generated Lean is written to application-owned temporary directories instead of overwriting the mathlib project.
- Source, image, compiler-output, timeout, and repair-attempt sizes are bounded.
- Cloud mode rejects client-selected Lean project paths.
- The current deployment is owner-oriented and uses an in-memory job store; it is not presented as a hardened public multi-tenant sandbox.

## Test and build

```bash
npm test
npm run typecheck
npm run build
```

The hackathon branch also runs these checks in `.github/workflows/hackathon-ci.yml`.

## Project structure

```text
src/client/                         React workbench
src/server/adapters/model/          OpenAI, Nebius/Nemotron, and demo model adapters
src/server/adapters/lean/           Lean process verifier and diagnostics
src/server/domain/                  proof pipeline, job state, safety boundaries
src/shared/                         shared schemas and types
lean-project/                       pinned Lean 4 / mathlib project
docs/hackathon-nebius-nvidia-2026.md  submission-period upgrade log
```

## Hackathon demo narrative

A strong demo uses a proof that does not succeed immediately:

1. show the UI reporting `Nebius · NVIDIA Nemotron`;
2. submit a natural-language or LaTeX proof;
3. show Nemotron's generated Lean code;
4. show the real compiler reject an imperfect attempt;
5. show the exact Lean diagnostic appear in the verification trajectory;
6. show Nemotron repair the code;
7. finish on a kernel-verified proof and the recorded attempt history.

This makes the agentic loop visible rather than presenting a single opaque LLM answer.

## Current limitations

- The default Nemotron route accepts text input, not handwritten images.
- Kernel verification proves the generated Lean theorem, not necessarily semantic faithfulness to an ambiguous informal statement.
- The current cloud architecture is not yet a general-purpose untrusted-code sandbox for public multi-tenancy.
- A live Nebius API key and hosted demo are still required before the hackathon submission can be considered deployment-complete.

## License

MIT. See `LICENSE`.
