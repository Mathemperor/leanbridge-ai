# ChatGPT plan production implementation plan

> **For agentic workers:** use superpowers:executing-plans task-by-task, with the required builder check and one whole-change review. User has selected and explicitly requested this integration.

**Goal:** Remove the production CLI and deliver a durable subscription-only mobile workbench.
**Architecture:** existing pipeline + OAuth HTTP model adapter + encrypted single-flight session + loopback code bridge + existing Sites owner form.
**Tech:** TypeScript, jose, Node fetch/crypto/fs, Express, existing LeanWeb adapter and Sites React worker.
**Spec:** ../specs/2026-10-28-chatgpt-plan-design.md

## Global constraints
- Official OAuth/Responses only, no API key or CLI fallback; retain current site, personal access and history.
- Tokens restricted to backend memory and protected /data; no credentials in logs, source, artifacts, browser state or URLs.
- Every inference requires completed SSE; exact selected model/effort, existing OCR→text→Lean pipeline.
- Atomic rotating refresh, single replica, transient errors preserve authorization.

## Review focus
- Setup replay/concurrency and malicious bridge destinations cannot replace the active account.
- Invalid signature/nonce/scopes, refresh revocation, 5xx and write failure cannot become a connected false positive.
- Partial/malformed/oversize streams and JSON outputs are validated before pipeline use.
- Cookie/Host/Origin and one-use setup ticket checks protect the local bridge.
- Deployment must actually remove the CLI and preserve the existing mounted volume/history.

### Task 1: Durable subscription session
Create src/server/adapters/model/chatgpt-plan-session.ts and test/chatgpt-plan-session.test.ts.
Interfaces: PlanSession.status(), startLogin(), completeLogin({ticket,state,code,clientId?}), accessToken(), catalog(); constructor accepts directory/clientId/backendOrigin/fetch/JWKS for controlled tests. Ticket setup POST form payload, atomic encrypted storage and request-driven serialized refresh.
- [ ] Add failing tests for encrypted restart persistence, single-flight rotating refresh, transient vs revoked errors and setup state/nonce/replay.
- [ ] Implement using official discovery/JWKS, cryptographic randomness and private filesystem writes; run session tests.

### Task 2: Model transport and CLI-free runtime
Create chatgpt-plan-model.ts / plan-stream.ts and tests; modify index/config/app, Docker startup and CI smoke.
- [ ] Add failing tests for OCR→pure-text translation/repair, settings, actual account model admission, delta-only completed streams, fail/EOF/limits and no credential errors.
- [ ] Implement ProofModel adapter; wire PlanSession through the existing protected Codex endpoints and narrow ticket callback route.
- [ ] Remove CLI installation and runtime import; run full backend tests/typecheck/build. Update smoke to assert no codex executable.

### Task 3: Desktop bridge and workbench connection form
Create scripts/authorize-chatgpt-plan.mjs plus protocol tests; modify existing Sites codex-connect only, retain original identity/history behavior.
- [ ] Add bridge Host/Origin/state/cookie/destination/replay tests; implement POST-only capability handoff and HTTPS code forwarding without any token export.
- [ ] Existing connection component renders the desktop POST form for plan login; run frontend tests/typecheck/build; publish existing project through native Sites workflow.

### Task 4: Release and real acceptance
- [ ] Whole-change review; fix Important findings with RED→GREEN coverage, then suites.
- [ ] Publish exact commit and CI-verified immutable image; review/stage Railway changes and attempt approved deploy once. If native review cancels, request the exact manual Apply→Deploy.
- [ ] Bootstrap once through official OAuth, verify encrypted session, refresh and persistence across restart, actual subscription original photo flow, real LeanWeb positives/negative/sorry, mobile history and memory. Preserve production evidence and deliver phone URL only after complete.
