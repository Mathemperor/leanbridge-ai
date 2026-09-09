# Nebius × NVIDIA Global AI Hackathon — LeanBridge AI upgrade log

This document records the work added during the 2026 hackathon submission period. LeanBridge AI existed before the event; the changes on `hackathon/nebius-nvidia-2026` are a substantial provider and deployment upgrade rather than a claim that the whole product was created during the event.

## Project thesis

LeanBridge AI turns an informal mathematical proof into Lean 4, runs the result through the real Lean/mathlib kernel, and feeds exact compiler diagnostics back into the model for bounded repair attempts. The core product idea is to make formal verification a practical correctness layer for AI-generated mathematics.

## Significant updates made during the submission period

### 1. NVIDIA Nemotron becomes a runtime proof-engine provider

The hackathon branch adds a dedicated Nebius Token Factory adapter using an NVIDIA Nemotron model. The provider participates in both:

- initial natural-language/LaTeX → Lean 4 translation;
- compiler-diagnostic-driven repair after a failed Lean verification attempt.

This is a functional runtime dependency, not a marketing-only integration.

Default hackathon model:

`nvidia/nemotron-3-super-120b-a12b`

Default Token Factory endpoint:

`https://api.tokenfactory.us-central1.nebius.com/v1/`

### 2. Provider-selectable architecture

The server can select `openai` or `nebius` through `MODEL_PROVIDER`. Existing OpenAI behavior remains available for comparison, while the public runtime configuration exposes the active provider and model.

### 3. Nebius credentials use the production secret boundary

`NEBIUS_API_KEY` follows the same server-only one-time secret-file path as the existing production secrets. Docker removes the raw provider keys from the child process environment after writing the protected runtime file. The browser never receives either provider key.

### 4. Tests define the Nemotron integration contract

The branch adds tests covering:

- Token Factory chat-completion request shape;
- JSON translation parsing;
- Lean source sanitization;
- compiler diagnostics in repair prompts;
- missing/invalid structured output;
- explicit rejection of image input for the current text-only Nemotron route;
- provider selection and Nebius-specific configuration;
- Nebius secret loading.

### 5. CI verification

The hackathon branch adds GitHub Actions CI for:

- automated tests;
- TypeScript typechecking;
- production build.

## Demo story

1. Paste an informal mathematical proof in natural language or LaTeX.
2. Select/run the Nebius-backed deployment.
3. Nemotron proposes a complete Lean 4 formalization.
4. Lean/mathlib compiles it inside the controlled backend.
5. If verification fails, exact Lean diagnostics are sent back to Nemotron.
6. The model repairs the proof within the configured attempt budget.
7. The UI shows the final verified Lean source and the attempt history.

The key distinction is that the LLM proposes proofs while the Lean kernel decides whether the generated formal proof is valid.

## Current limitations to disclose

- The default Nemotron route is text-only; handwritten-image input remains supported by the OpenAI provider until a compatible NVIDIA vision route is added.
- The current cloud mode is owner-only and uses an in-memory job store; it is not yet a public multi-tenant sandbox.
- A Lean-verified formalization can still misrepresent an ambiguous informal source, so semantic fidelity remains a review concern distinct from kernel validity.

## Submission checklist still to complete

- Run CI and resolve any failures.
- Exercise the integration against a real Nebius Token Factory key and record a reproducible proof example.
- Deploy the Nebius-backed branch for the demo.
- Create a concise architecture diagram and a <=3 minute demo video.
- Prepare a public submission repository or public release containing the hackathon work without secrets.
- Add the required Devpost project description and explicit pre-existing-project disclosure.
- Submit actionable feedback on Nebius/NVIDIA tooling for eligibility for the feedback award.
- If eligible through an attended Builders & Brews city event, select that city in the submission.
