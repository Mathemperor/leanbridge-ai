# Devpost submission draft — LeanBridge AI

> Working draft for the Nebius × NVIDIA Global AI Hackathon. Replace bracketed deployment/video placeholders only with verified public links before submission. Any claim about live Nebius or Tavily usage must be backed by a real runtime run from the submission build.

## Project name

LeanBridge AI — Kernel-Verified Mathematical Proof Agent

## Track

Best Apps and Agents

Track selection follows the [official rules checked on September 27, 2026](https://nebiusglobalaihackathon.devpost.com/rules). LeanBridge uses a Nemotron proof agent through Token Factory with its own Docker-based Lean verifier. It does not currently use the Token Factory Sandboxes described for the coding track.

## One-line pitch

LeanBridge turns informal mathematics into Lean 4 with NVIDIA Nemotron on Nebius Token Factory, optionally grounds the initial translation with Tavily Lean/mathlib search, and uses the real Lean compiler as a deterministic feedback loop that rejects and repairs incorrect formalizations.

## What it does

Mathematical LLM output can look convincing while still containing subtle errors. LeanBridge treats the model as a proof proposer rather than an authority.

A user submits a natural-language or LaTeX proof. When Tavily grounding is enabled, LeanBridge first performs one bounded search over an allowlisted set of Lean/mathlib sources and marks the returned text as untrusted reference material. NVIDIA Nemotron, served through Nebius Token Factory, then translates the proof into Lean 4. LeanBridge compiles the result against a pinned Lean/mathlib environment. If the proof fails, the application captures bounded compiler diagnostics and sends those diagnostics back to Nemotron for another repair attempt. The process stops when Lean verifies the proof, the repair budget is exhausted, or the user disables automatic repair.

The workbench exposes the active provider/model, Tavily grounding state, generated Lean source, kernel-verification state, compiler diagnostics, repair trajectory, and manual re-verification controls.

## Why Nebius + NVIDIA are essential

The Nebius/NVIDIA integration is a runtime dependency, not a branding layer.

- `src/server/adapters/model/nebius-proof-model.ts` makes Token Factory inference calls.
- `nvidia/nemotron-3-super-120b-a12b` is the default hackathon proof-generation model.
- Nemotron is used for both the first Lean translation and compiler-diagnostic repair.
- The UI displays the active Nebius/Nemotron provider and model.
- Lean verification is performed independently of the LLM, creating a model → compiler → model agentic loop.

## Optional Tavily grounding

The hackathon branch includes `src/server/adapters/grounding/tavily-mathlib-grounder.ts` as an optional pre-translation grounding layer.

When enabled, it makes one Tavily Search API runtime call using `search_depth: basic`, caps the result count and returned text, and restricts accepted result URLs to approved Lean/mathlib documentation or source repositories. Retrieved text is explicitly treated as untrusted context and cannot override the proof-generation or verification rules. If Tavily is unavailable, the system fails open to the primary Nebius/Nemotron path.

**Evidence gate for the Best Use of Tavily bonus:** do not claim this bonus integration as live-verified until the public demo has executed a successful Tavily API request from the submitted build and the UI visibly reports `Tavily mathlib grounding`.

## Technical implementation

The application is a TypeScript/React/Express system with four main boundaries:

1. **Grounding boundary** — optional Tavily search provides bounded, allowlisted, untrusted Lean/mathlib reference snippets before the first translation.
2. **Model boundary** — provider adapters produce a structured proof translation. The hackathon path uses Nebius Token Factory with NVIDIA Nemotron.
3. **Verification boundary** — generated Lean runs in a pinned Lean 4 + mathlib environment. Source guards reject `sorry`, `admit`, and selected compile-time execution escape hatches.
4. **Repair boundary** — failed compiler output is normalized and bounded before becoming a Nemotron repair prompt. Repair attempts are capped.

The production container runs as a non-root user. OpenAI, Nebius, Tavily, and backend credentials stay server-side, are removed from the raw child-process environment during Docker startup, and are not forwarded to Lean subprocesses.

## Design

LeanBridge is intentionally a workbench rather than a chat box. The UI keeps three concerns visible at once:

- the informal source proof;
- the generated/editable Lean program;
- the verification and repair trajectory.

Runtime badges separately expose the active model path and whether Tavily grounding is enabled. This makes it possible to inspect what the model proposed, which external tools participated, and what the kernel actually accepted.

## Potential impact

The immediate audience is mathematics students, researchers, formal-methods practitioners, educators, and AI tooling developers who want a practical bridge between informal proofs and machine-checkable mathematics.

The broader pattern is reusable beyond mathematics: retrieval can supply references, an open model proposes an artifact, a deterministic tool validates it, and exact tool feedback drives bounded repair. LeanBridge demonstrates that pattern in a domain where correctness is especially important and independently checkable.

## What was significantly updated during the submission period

LeanBridge AI existed before the hackathon. During the submission period the project received a substantial new provider, grounding, and deployment path:

- added a dedicated Nebius Token Factory proof-model adapter;
- added NVIDIA Nemotron as a runtime model for initial Lean generation and repair;
- added optional Tavily Lean/mathlib grounding for the initial translation;
- introduced provider selection between OpenAI and Nebius;
- extended server-only secret handling to Nebius and Tavily credentials;
- added Nebius/Tavily integration, configuration, secret, grounding, UI, and deployment tests;
- made the active Nebius/Nemotron runtime and Tavily grounding state visible in the product UI;
- added hackathon-specific CI for tests, typechecking, and builds;
- added public-release, demo, and submission documentation.

The full dated upgrade record is in `docs/hackathon-nebius-nvidia-2026.md`.

## Working demo

Public demo: **[ADD VERIFIED DEPLOYMENT URL]**

Testing notes:

- text/LaTeX input is the intended Nemotron demo route;
- handwritten-image input is not part of the default Nemotron route;
- the demo should visibly report `Nebius · NVIDIA Nemotron` before the proof is submitted;
- if pursuing the Tavily bonus, the demo should also visibly report `Tavily mathlib grounding` and execute a real Tavily runtime request;
- choose a proof that demonstrates at least one real Lean compiler check and, ideally, one repair cycle.

## Public repository

Repository: **[ADD PUBLIC REPOSITORY URL AFTER VISIBILITY CHANGE]**

The release must contain the MIT `LICENSE`, this README, complete source, setup instructions, and no secrets.

## Demo video

YouTube: **[ADD PUBLIC <=3 MINUTE YOUTUBE URL]**

Recommended narration and shot list: `docs/demo-video-script.md`.

## Nebius / NVIDIA / Tavily feedback draft

Do not convert this section into factual product feedback until the live external-service smoke test and deployment have been performed.

### What worked well

- [Record concrete observations from the first successful live Token Factory call.]
- [Record model/API behavior that materially simplified the adapter.]
- [If Tavily is enabled, record one concrete observation from the actual search response and integration flow.]
- [Record deployment or debugging details that were especially effective.]

### What could improve

- [Record a reproducible API/documentation friction point, including endpoint/model and expected behavior.]
- [Record any structured-output compatibility issue actually observed.]
- [Record any Tavily search/relevance or documentation-source issue actually observed.]
- [Record any deployment/logging/model-discovery issue actually observed.]

### Potential impact of the feedback

Prefer feedback that would make it easier for another developer to reproduce an open-model + retrieval + deterministic-verifier loop, not generic praise or unsupported complaints.

## Final pre-submit evidence gate

Do not submit until all of these are true:

- the live project makes a confirmed Nebius Token Factory runtime call;
- if the Tavily bonus is claimed, the submitted build makes a confirmed functional Tavily API runtime call;
- the demo/test-build URL loads and judges have any required private access instructions;
- the UI correctly reports Nebius/Nemotron when the live path is active;
- the UI correctly reports Tavily grounding if that integration is enabled in the submitted demo;
- at least one proof is shown being checked by real Lean/mathlib;
- repository visibility is public and the MIT license is visible;
- README setup steps work from a clean checkout;
- CI is green on the exact public submission commit;
- the video is public on YouTube and no longer than three minutes;
- the significant-update disclosure is included;
- feedback contains only observations actually made during live use;
- no API keys, backend tokens, bank details, private files, or other secrets are committed or shown in the video.
