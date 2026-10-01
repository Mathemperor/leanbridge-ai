# Nebius × NVIDIA Global AI Hackathon — LeanBridge AI upgrade log

This document records the work added during the 2026 hackathon submission period. LeanBridge AI existed before the event; the changes on `hackathon/nebius-nvidia-2026` are a substantial provider, grounding, and deployment upgrade rather than a claim that the whole product was created during the event.

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

### 2. Optional Tavily grounding is added before initial formalization

The hackathon branch adds `src/server/adapters/grounding/tavily-mathlib-grounder.ts` as an optional grounding layer for the Nebius text path.

The integration:

- performs one bounded Tavily `basic` search before the initial Nemotron translation;
- caps query length, result count, per-result text, and total context;
- restricts accepted result URLs to Lean/mathlib documentation and source locations;
- marks retrieved text as untrusted reference material rather than executable instructions;
- fails open to the primary Nebius/Nemotron path if Tavily is unavailable;
- exposes the enabled Tavily state in the product UI.

The purpose is to help the model discover plausible theorem/API names while keeping the Lean compiler as the final authority.

A real Tavily API runtime call still needs to be captured in the deployed submission before the project can claim live eligibility for the hackathon's Tavily bonus award.

### 3. Provider-selectable architecture

The server can select `openai` or `nebius` through `MODEL_PROVIDER`. Existing OpenAI behavior remains available for comparison, while the public runtime configuration exposes the active provider, model, and Tavily grounding state.

### 4. Nebius and Tavily credentials use the production secret boundary

`NEBIUS_API_KEY` and `TAVILY_API_KEY` follow the same server-only one-time secret-file path as the existing production secrets. Docker removes the raw provider/grounding keys from the child process environment after writing the protected runtime file. The browser never receives these keys, and Lean subprocesses run with an allowlisted environment.

### 5. Tests define the Nemotron + Tavily integration contract

The branch adds tests covering:

- Token Factory chat-completion request shape;
- JSON translation parsing;
- Lean source sanitization;
- compiler diagnostics in repair prompts;
- missing/invalid structured output;
- explicit rejection of image input for the current text-only Nemotron route;
- provider selection and Nebius-specific configuration;
- Tavily configuration gates;
- Tavily request shape, bounded search, domain filtering, context limits, and error behavior;
- fail-open grounding behavior in the Nemotron adapter;
- Nebius/Tavily secret loading;
- UI visibility for Nebius/Nemotron and Tavily grounding state;
- Docker secret-boundary deployment behavior.

### 6. CI verification

The hackathon branch adds GitHub Actions CI for:

- automated tests;
- TypeScript typechecking;
- production build.

## Demo story

1. Paste an informal mathematical proof in natural language or LaTeX.
2. Run the Nebius-backed deployment; optionally enable Tavily grounding.
3. If enabled, Tavily retrieves bounded Lean/mathlib reference snippets.
4. Nemotron proposes a complete Lean 4 formalization.
5. Lean/mathlib compiles it inside the controlled backend.
6. If verification fails, exact Lean diagnostics are sent back to Nemotron.
7. The model repairs the proof within the configured attempt budget.
8. The UI shows the final verified Lean source and the attempt history.

The key distinction is that search can suggest references and the LLM can propose proofs, while the Lean kernel decides whether the generated formal proof is valid.

## Current limitations to disclose

- The default Nemotron route is text-only; handwritten-image input remains supported by the OpenAI provider until a compatible NVIDIA vision route is added.
- Tavily grounding currently runs before the initial translation rather than before each repair attempt.
- The current cloud mode is owner-only and uses an in-memory job store; it is not yet a public multi-tenant sandbox.
- A Lean-verified formalization can still misrepresent an ambiguous informal source, so semantic fidelity remains a review concern distinct from kernel validity.
- No external-service live claim should be made until a deployed build has exercised the corresponding real API call.

## Submission checklist still to complete

- Finish CI verification on the latest Tavily-enabled commit and resolve any failures.
- Exercise the integration against a real Nebius Token Factory key and record a reproducible proof example.
- If pursuing the Tavily bonus, exercise a real Tavily runtime call from the same deployed build and capture evidence.
- Deploy the Nebius-backed branch for the demo.
- Create a concise architecture diagram and a <=3 minute demo video.
- Prepare a public submission repository or public release containing the hackathon work without secrets.
- Finalize the Devpost project description and explicit pre-existing-project disclosure.
- Submit actionable feedback based only on actual Nebius/NVIDIA/Tavily use.
- If eligible through an attended Builders & Brews city event, select that city in the submission.
