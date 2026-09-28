# LeanBridge AI

**AI proposes the proof. Lean decides whether it is valid.**

LeanBridge AI is a proof-formalization workbench for turning informal mathematics into executable Lean 4 proofs. On the 2026 hackathon branch, **NVIDIA Nemotron runs through Nebius Token Factory** to generate Lean code and to repair failed proofs using exact compiler diagnostics from a real Lean/mathlib environment. An optional Tavily grounding step can search bounded Lean/mathlib references before the initial Nemotron call.

This branch is being prepared for the **Nebius × NVIDIA Global AI Hackathon — Best Apps and Agents Track**. The [current rules](https://nebiusglobalaihackathon.devpost.com/rules) describe Token Factory Sandboxes for the coding track; LeanBridge currently runs its verifier in its own Docker environment, so the apps-and-agents track matches the implemented architecture.

## Why it matters

LLMs can produce convincing mathematical text while still making subtle logical or formal mistakes. LeanBridge adds a deterministic correctness boundary:

1. A user submits a natural-language or LaTeX proof.
2. Optionally, Tavily retrieves bounded Lean/mathlib reference snippets from an allowlisted set of documentation/code domains.
3. NVIDIA Nemotron generates a Lean 4 formalization through Nebius Token Factory.
4. The backend compiles the result with real Lean 4 + mathlib.
5. If compilation fails, LeanBridge sends bounded compiler diagnostics back to Nemotron.
6. Nemotron repairs the proof within a configurable attempt budget.
7. The UI preserves the generated Lean source, verification result, and repair trajectory.

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

### Optional Tavily mathlib grounding

The optional grounder lives in:

`src/server/adapters/grounding/tavily-mathlib-grounder.ts`

When enabled, LeanBridge makes one bounded `basic` Tavily Search API call before the initial Nemotron translation. The query is length-limited, results are capped, and returned context is restricted to approved Lean/mathlib sources. Retrieved text is explicitly marked as **untrusted reference material**: it may help Nemotron discover theorem/API names, but instructions embedded in retrieved content are ignored and the Lean compiler remains the correctness authority.

If Tavily is temporarily unavailable, grounding fails open and the primary Nebius/Nemotron → Lean pipeline continues without search context.

Enable it only on the Nebius text path:

```dotenv
TAVILY_GROUNDING_ENABLED=true
TAVILY_API_KEY=your_server_side_tavily_key
```

### Lean 4 + mathlib

The production Docker image pins Lean 4 and mathlib to `v4.24.0`. Generated code is compiled in an isolated temporary directory. The project rejects `sorry`, `admit`, and several compile-time execution escape hatches before verification.

## Significant 2026 hackathon updates

LeanBridge AI existed before the submission period. The hackathon branch adds substantial new work rather than presenting the pre-existing product as newly created:

- dedicated Nebius Token Factory provider;
- NVIDIA Nemotron as a runtime proof-generation and repair engine;
- optional Tavily mathlib grounding with bounded, allowlisted retrieval;
- provider-selectable architecture (`openai` or `nebius`);
- Nebius and Tavily credential handling through the production one-time secret-file boundary;
- UI visibility for the active Nebius/Nemotron runtime and Tavily grounding state;
- provider/configuration/grounding/deployment regression tests;
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

# Optional Tavily grounding
TAVILY_GROUNDING_ENABLED=true
TAVILY_API_KEY=your_server_side_tavily_key

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
TAVILY_GROUNDING_ENABLED=false
LEANBRIDGE_BACKEND_TOKEN=generate_a_long_random_backend_secret
LEANBRIDGE_ACCESS_PASSWORD=generate_a_different_random_browser_password
```

Build and smoke-test locally:

```bash
cp .env.docker.example .env.docker
# fill in the server-side secrets in .env.docker
npm run docker:build
npm run docker:smoke
```

Open the workbench and enter the separate browser access password. API keys and the backend token stay on the server. Remote use requires HTTPS; loopback HTTP works for local testing. See [browser access and shared judge-workbench limitations](docs/browser-access.md).

On Windows, `START_FIXED_PREFLIGHT_V2.bat` launches the independent PowerShell script and pauses on success or failure. Its default target is the owner's downloaded repository. From a different checkout, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\leanbridge_preflight_v2.ps1 -RepoPath .` instead. The script reads local `.env`, generates `.env.docker`, builds the container, and checks health and authenticated Lean readiness. It does not make model or Tavily calls.

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
optional Tavily Lean/mathlib grounding
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

- Provider and grounding API keys remain server-side and are never included in the browser bundle.
- Docker startup moves OpenAI, Nebius, Tavily, and backend credentials into a temporary secret file, unsets the raw environment variables, and removes the file after Node reads it.
- Tavily queries, result counts, per-result text, total returned context, and accepted result domains are bounded.
- Retrieved Tavily text is treated as untrusted reference material and is never an authority over the Lean compiler.
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
src/client/                          React workbench
src/server/adapters/model/           OpenAI, Nebius/Nemotron, and demo model adapters
src/server/adapters/grounding/       optional Tavily Lean/mathlib grounding
src/server/adapters/lean/            Lean process verifier and diagnostics
src/server/domain/                   proof pipeline, job state, safety boundaries
src/shared/                          shared schemas and types
lean-project/                        pinned Lean 4 / mathlib project
docs/hackathon-nebius-nvidia-2026.md submission-period upgrade log
```

## Hackathon demo narrative

A strong demo uses a proof that does not succeed immediately:

1. show the UI reporting `Nebius · NVIDIA Nemotron` and, when enabled, `Tavily mathlib grounding`;
2. submit a natural-language or LaTeX proof;
3. show Nemotron's generated Lean code;
4. show the real compiler reject an imperfect attempt;
5. show the exact Lean diagnostic appear in the verification trajectory;
6. show Nemotron repair the code;
7. finish on a kernel-verified proof and the recorded attempt history.

This makes the agentic loop visible rather than presenting a single opaque LLM answer.

## Current limitations

- The default Nemotron route accepts text input, not handwritten images.
- Tavily grounding currently runs before the initial translation; repair attempts rely on the generated Lean plus exact compiler diagnostics rather than making another search call.
- Kernel verification proves the generated Lean theorem, not necessarily semantic faithfulness to an ambiguous informal statement.
- The current cloud architecture is not yet a general-purpose untrusted-code sandbox for public multi-tenancy.
- Live Nebius/Tavily credentials and a hosted demo are still required before those external runtime paths can be claimed as deployment-verified.

## License

MIT. See `LICENSE`.
