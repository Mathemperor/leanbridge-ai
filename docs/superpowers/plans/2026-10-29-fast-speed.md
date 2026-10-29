# LeanBridge Fast Speed Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add an honest opt-in official Fast speed control to the mobile subscription workflow.

**Architecture:** Extend the existing additive proof request/settings contract, route the selected tier through the current OAuth HTTP model adapter, and retain actual tier metadata from the terminal event. Extend the existing Sites frontend and proxy without changing authentication, billing provider, proof checking or storage schema.

**Tech Stack:** TypeScript, Zod, Vitest/Supertest, React, Vinext/Cloudflare Workers, existing GitHub Actions/GHCR/Railway release.

**Spec:** docs/superpowers/specs/2026-10-29-fast-speed-design.md

## Global Constraints

- Production inference uses the saved ChatGPT subscription only, with no CLI or API-key fallback.
- Speed never changes the chosen model/reasoning strength or skips real LeanWeb validation.
- Default Standard; optional Fast; no blanket 1.5x promise for Astra. State faster subscription consumption before use.
- Respect native tool approval/access checks, current Sites audience, owner authorization and existing private volume.
- Preserve old records/requests and disable unsupported Fast controls while the old backend is still deployed.

## Review Focus

- Remembered Fast preference with old backend: omit the field and disable the choice (Task 2).
- Fast request actually processed as default or with missing tier: honest status/export (Tasks 1–2).
- Image recognition followed by text generation and repair: same selected speed throughout (Task 1).
- Unsupported Fast/account capability and arbitrary provider error bodies: categorical, bounded, no sensitive reflections or fallback (Task 1).
- Manual proof/history records lacking speed: still render, export and compile (Task 2).

### Task 1: Backend protocol and transport

Files: src/shared/codex-options.ts, src/shared/proof.ts, src/server/app.ts, src/server/domain/job-store.ts, src/server/adapters/model/chatgpt-plan-model.ts, plan-stream.ts; tests in test/chatgpt-plan-model.test.ts, test/plan-stream.test.ts and focused route tests.

Produces: optional `CodexSettings.speed`, catalog `speeds/defaultSpeed`, request validation; optional trusted `serviceTier` metadata on model outputs. Consumed by Task 2.

- [x] Write and run failing tests for exact HTTP tiers/default omission, image/repair and queue propagation, job selection storage, actual tier/downgrade, safe unsupported-speed errors and capped error bodies.
- [x] Implement the minimal additive contracts and transport behavior.
- [x] Run focused tests, then backend `npm test`, `npm run typecheck`, `npm run build` after final integration; 305 tests passed, typecheck and build succeeded.

### Task 2: Mobile speed controls and persistence

Files in existing Site clone: app/proof-api.ts, model-settings.tsx, page.tsx, cloud-panels.tsx, proof-history.tsx, proof-export.ts, worker/cloud-api.ts; relevant tests and rendered HTML checks.

Consumes: Task 1's fields and catalog capabilities. Produces: working selector, persisted browser preference, owner-proxy validation, requested/actual speed on history/results/exports.

- [x] Write and run failing tests for preference migration, old-backend omission/gating, tier forwarding/rejection, result/export fallbacks.
- [x] Implement the selector and additive request/result plumbing; preserve the existing visual design.
- [x] Run Site `npm test`, `npx tsc --noEmit` and supported production build; final 103 unit and 2 rendered HTML tests passed, typecheck and build succeeded. Publication packaging is Task 3.

### Task 3: Review, publication and real acceptance

- [x] Independently review the combined changes, especially actual/requested tier and subscription-only behavior; fix material findings with RED→GREEN coverage.
- [ ] Publish backend source and verified immutable image through the existing workflow; stage the matching Railway image without touching saved grants. Respect deployment approval outcomes.
- [ ] Push/package/save/deploy the exact Site source using its native helper and tools. Preserve audience and owner checks.
- [ ] Confirm production control, real Fast request effective tier and real LeanWeb result when permitted. Never claim a fixed 1.5x result or a live pass from unit tests.
- [ ] Save evidence/update handoff and retain source workspaces. Do not retry previously policy-blocked recursive scratch deletion.

## Progress

Base backend 18f913b; base Site 99e509d. Existing dedicated task clones are clean. Native Site source opened before editing; no new repository, user account, model or billing route.
Preflight Task 1–2: `speed` is additive; backend catalog enables the frontend control, avoiding Fast submissions to the old runtime.
Preflight Task 1–3: effective `serviceTier` comes only from upstream completion metadata; publication/live tests must inspect it.

Local evidence: outputs/LeanBridge/evidence/fast-backend-tests-20261029.log, fast-backend-build-20261029.log and fast-site-tests-20261029.log in the task workspace. Additional stream regressions verified RED before restoring the categorical error mapping. No model credentials or owner identity were used in test doubles.

Production preflight: Railway retains the previous verified immutable image, private 500 MB volume and saved authorization; no pending changes. The user's previous Astra Max task c2f2ccb6-c7af-4cd6-a57a-dd840ac3d4e0 finished with real Lean verification at 2026-10-29T03:29:33.871Z, so it is no longer in flight. This is baseline evidence, not Fast acceptance.

Independent read-only review found two display gaps: history lacked requested/actual labels and dropped actual-tier metadata; OCR missing-tier metadata was hidden. Both were fixed with observed failing regressions then passing tests. Six targeted review checks passed with no outstanding material findings. Final frontend suite/build and typecheck passed after those corrections. A 390 px mobile local preview confirmed the speed control layout and logged-out gating; this is not a production Fast response.
