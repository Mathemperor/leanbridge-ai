# Subscription Fast capability diagnostic implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; one final whole-change review.

**Goal:** Determine whether the existing subscription route exposes Fast and whether structured output prevents its use, without falsely claiming acceleration.

**Architecture:** Add a separate bounded diagnostic profile to the existing one-shot startup check. Normal application inference remains unchanged. Reuse encrypted session storage, public OAuth endpoints and real LeanWeb verifier.

**Tech Stack:** TypeScript, Node 22, Vitest, GitHub Actions, GHCR, Railway.

**Spec:** `docs/superpowers/specs/2026-10-29-fast-capabilities.md`

## Global constraints

Only existing ChatGPT-plan OAuth; no API keys, CLI runtime, model/effort substitution, identity spoofing or history deletion. Claim once before network; maximum three 90-second requests before the overall future deadline. Logs are allowlisted metadata only. No new external endpoint.

## Review focus

- Unknown profile must fail closed before catalog or inference.
- Untrusted catalog tier fields and error prose must not enter logs verbatim.
- A terminal response's `default` must remain standard even if Fast was requested.
- Auth/quota/transport/compiler outages stop subsequent controls.
- Claim persists across failure/restart; no duplicate allowance consumption.

### Task 1: Safe account-specific tier catalog

**Files:** `src/server/adapters/model/chatgpt-plan-session.ts`, `test/chatgpt-plan-session.test.ts`.

**Interface:** `inspectTierCatalog(): Promise<PlanTierCapability[]>`, preserving only fixed known tier IDs and metadata-field presence, via the session's existing authenticated public catalog request.

- [x] Add failing tests for catalog field normalization, visibility and secret/prose stripping.
- [x] Run targeted tests and confirm expected failure.
- [x] Implement the method without changing `catalog()` output or stored grants.
- [x] Run targeted tests green.

### Task 2: Bounded minimal-request profile

**Files:** `src/server/release-check.ts`, new `src/server/tier-capability-check.ts`, `src/server/index.ts`, `test/release-check.test.ts`.

**Interface:** `runTierCapabilityCheck(options)` consumes the already-claimed session/verifier/log/deadline; `LEANBRIDGE_RELEASE_CHECK_PROFILE=tier-capabilities-v1` selects it. Missing profile retains the existing compatibility check; unknown profile makes no network call.

- [x] Add failing tests for one-shot minimal default/priority/fast requests, same Astra/Max, terminal tier/Lean outcomes, privacy, unknown profile, deadlines and shared-failure stop conditions.
- [x] Run and verify the intended failures.
- [x] Implement serial direct requests with existing safe SSE parser and proof pipeline; no repairs, no normal inference changes.
- [x] Run the full test suite, typecheck and build; review the whole diff. 337 tests pass; deadline and shared-status review findings fixed with six RED→GREEN regressions and re-reviewed.

### Task 3: Publish and observe

- [ ] Publish a verified source commit using the expected-head lease; record exact commit and image digest.
- [ ] Require GitHub Actions real LeanWeb container checks to pass.
- [ ] Stage the immutable image and bounded temporary ID/deadline/profile in the existing service, preserving auth volume.
- [ ] Respect deployment tool approval; if cancelled, provide the exact official manual deploy step.
- [ ] After acknowledged deployment, read terminal safe results, clear temporary variables, preserve evidence and report actual tier truthfully.
