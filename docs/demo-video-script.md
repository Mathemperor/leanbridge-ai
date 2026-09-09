# LeanBridge AI — demo video script (target: 2:35–2:50)

The hackathon video must stay under three minutes. This script leaves a small timing margin and keeps every technical claim visible on screen.

## 0:00–0:15 — Problem

**Screen:** LeanBridge home/workbench, with the runtime header visible.

**Narration:**

“Language models can write mathematical proofs that sound convincing but still contain subtle errors. LeanBridge treats the model as a proposer, then asks a real theorem prover to decide whether the formal proof is valid.”

## 0:15–0:36 — Show the runtime stack

**Screen:** zoom or point to `Nebius · NVIDIA Nemotron`, the model name, `Tavily mathlib grounding` if the deployed build actually enables it, and `Cloud Lean ready` / the Lean-ready status.

**Narration:**

“This build uses NVIDIA Nemotron through Nebius Token Factory. For the Tavily-enabled demo, one bounded search can ground the initial translation in Lean and mathlib references. Nemotron generates and repairs Lean 4 code; a pinned Lean and mathlib environment verifies it independently.”

**If Tavily is not live in the submitted deployment:** omit the Tavily sentence and do not show or claim the bonus integration as active.

## 0:36–0:58 — Submit an informal proof

**Screen:** paste a short natural-language or LaTeX proof. Keep automatic repair enabled. Click Generate and Verify.

**Narration:**

“I can start from ordinary mathematical text. If grounding is enabled, retrieved snippets are treated only as untrusted references. Then the request goes to Token Factory, Nemotron returns a structured formalization, and LeanBridge extracts the Lean program for verification.”

## 0:58–1:27 — Show generated Lean and kernel check

**Screen:** generated Lean source in the center panel, verification trajectory on the right. Show the real compiler command/result.

**Narration:**

“The important boundary is here: neither retrieval nor the model certifies the answer. Lean compiles the generated source against mathlib. LeanBridge also rejects shortcuts such as `sorry` and `admit` before verification.”

## 1:27–1:57 — Show repair loop

**Preferred screen:** a real example where the first generated proof fails, the Lean diagnostic is recorded, and Nemotron repairs it.

**Narration:**

“When Lean rejects an attempt, its diagnostic becomes tool feedback for the agent. LeanBridge bounds that diagnostic, sends it back to Nemotron, and asks for a corrected proof. The loop is capped, so it cannot repair forever.”

**Fallback if the chosen live example succeeds on the first attempt:** show a previously captured, reproducible live run from the same submission commit. Do not simulate or claim a repair that did not actually occur.

## 1:57–2:20 — Finish on verified output

**Screen:** green verified state, final Lean source, attempt history. Optionally make a harmless manual edit and use Re-verify to show that manual validation does not invoke the model again.

**Narration:**

“The final result is inspectable Lean code plus a verification trail. Users can edit the code and re-run Lean directly. Search can suggest references, the model proposes, and the kernel decides.”

## 2:20–2:39 — Architecture and security

**Screen:** README architecture block or a simple diagram made from the repository documentation.

**Narration:**

“Provider and grounding credentials stay server-side and are not forwarded to Lean subprocesses. Tavily input and output are bounded, the production container runs non-root, the Lean project is pinned, and generated files are compiled in temporary directories.”

## 2:39–2:50 — Impact / close

**Screen:** final verified proof and project name.

**Narration:**

“LeanBridge is a practical bridge from informal mathematics to machine-checked proofs, and a reusable agent pattern: retrieve references, generate, verify with a deterministic tool, and repair from exact feedback.”

## Capture checklist

Before recording, verify all of the following on the exact submission deployment:

- the header visibly says `Nebius · NVIDIA Nemotron`;
- the displayed model is the actual NVIDIA model used in the live call;
- if pursuing the Tavily bonus, the header visibly says `Tavily mathlib grounding` and the recorded run actually makes a successful Tavily API runtime call;
- the run reaches a real Lean/mathlib verification step;
- any repair cycle shown actually occurred in the recorded/live system;
- no provider keys, grounding keys, backend tokens, environment-variable screens, browser password managers, bank information, or private repository URLs are visible;
- no copyrighted background music is used;
- the final exported video is under 3:00 before uploading to YouTube.

## Suggested demo input selection

Use a proof that is:

- short enough to fit comfortably in a three-minute demo;
- nontrivial enough that formalization is meaningful;
- stable enough that the live model usually completes quickly;
- likely to benefit from a recognizable mathlib theorem/API name when Tavily grounding is enabled;
- likely to produce useful compiler diagnostics if the first Lean attempt is imperfect.

Do not pre-claim a repair rate, model accuracy, or Tavily relevance improvement. Capture those metrics only after running reproducible live evaluations on the submitted external-service path.
