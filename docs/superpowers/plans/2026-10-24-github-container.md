# GitHub Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify LeanBridge in GitHub Actions, then deploy its immutable GHCR image in Railway.

**Architecture:** The existing Dockerfile remains the image definition. A trusted-branch workflow builds on Ubuntu, verifies the container, and publishes it; Railway receives a staged image-source change only after the image is ready.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Node.js 22, Railway, Lean 4.24 / Mathlib.

**Spec:** `docs/superpowers/specs/2026-10-24-github-container-design.md`

## Global Constraints

- Keep Codex subscription inference and `/data` authorization; no API fallback or production credentials in CI.
- Build `linux/amd64`; container verification uses 512 MiB, no swap, and one CPU.
- Keep the pinned Lean/Mathlib versions and current model-selection implementation.
- Preserve the Site identity and data; change Railway source only to a verified digest.
- Public GHCR access must be observed before Free-plan deployment.

## Review Focus

- A failed smoke check must prevent publication.
- No production tokens, auth files, or inference calls may enter CI.
- Incorrect and placeholder proofs must fail for the right reason, while real Mathlib proofs pass.
- The tested revision and deployed digest must match; never redeploy the old source image as a substitute.
- Switching to an image source must retain healthcheck settings previously supplied by railway.json.

### Task 1: Verified image publication

**Files:** Create `.github/workflows/container.yml`, `scripts/container-smoke.mjs`, and `docs/github-container.md`.

- [x] Implement a branch-scoped, commit-pinned Actions workflow with a 90-minute timeout and scoped package permissions.
- [x] Implement a disposable-container acceptance script; output only nonsecret JSON evidence and always remove the test container.
- [x] Run `node --check scripts/container-smoke.mjs`, actionlint, and diff checks; review workflow and script independently.
- [ ] Publish through the existing GitHub connection and observe the actual workflow. Inspect and repair observed failures.
- [ ] Record the image digest and verify public availability; stage the Railway image source and explicit healthcheck/restart settings.
- [ ] Observe the actual Railway image deployment and complete production acceptance before announcing delivery.

## Execution ledger

- User explicitly selected and authorized this migration; no new design-choice approval is required. Existing Railway deployment access checks remain in force.
- Isolated checkout `work/leanbridge-actions` starts at `9c3c3a5`; previous dirty checkout and all user files are preserved.
- Static tests duplicating YAML are not added. Actionlint and real constrained-container verification are the relevant checks.
- Independent review found no runtime API mismatch or secret exposure; identified the missing image-size gate. Added an actual registry-manifest check before the successful deployment summary, with boundary and malformed-manifest tests.
- Ruling: registry compressed size is only available after image publication. A size failure may leave an unpublished-to-Railway GHCR artifact, but fails the workflow and blocks deployment. The conservative 4 GB gate and actual Railway admission are both required; local uncompressed size is recorded, not confused with registry blob size.
- Ruling: live Railway checks, public GHCR access and subscription generation remain required later stages, not waived by CI. Mutable dependencies inherited from the existing Dockerfile are retained for this migration; source commit, action revisions and deployed image digest are pinned.
