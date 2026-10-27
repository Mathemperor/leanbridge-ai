# Two-stage Image Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Automatically transcribe photographed questions/solutions to editable text and LaTeX before Codex generates Lean.

**Architecture:** Shared bounded transcription data; sequential Codex CLI stages; retained job JSON; a mobile transcription editor whose retries create text jobs. Backend and Site tasks run independently after the shared contract is fixed.

**Tech Stack:** Existing TypeScript, Zod, React/Vinext, Codex CLI 0.163.0, LeanWeb 4.24.0, Railway and Sites.

**Spec:** `docs/superpowers/specs/2026-10-27-two-stage-image-design.md`

## Global Constraints

- Codex subscription only; no inference API fallback or new provider.
- Preserve hosting IDs, auth, owner access, history and user data.
- Image payload reaches the recognition call only and is released before formalization.
- Never compile rejected placeholders or unsafe source; real LeanWeb success is required.
- Four 8,000-character fields, twenty 200-character uncertainties, text input under 50,000.
- Recognition deadline defaults to 180,000 ms and is bounded to 30,000–300,000.

## Review Focus

- Empty/unreadable problem: retain recognition and fail before formalization.
- Partial solution/ambiguity: retain uncertainty text without invented completion.
- Formalization failure: recognition stays visible, editable and exportable.
- Edited retries: create a new text job, preserve edits, and never silently reread the image.
- Legacy records and deleted history: rendering remains compatible and does not recreate deleted rows.

## Task 1 — Shared contract (root)

Files: `src/shared/proof.ts`, `src/shared/proof.test.ts`.

- [ ] Add failing schema/format tests for bounds, missing solution, edited text request, and the 50,000-character total.
- [ ] Add `imageTranscriptionSchema`, `ImageTranscription`, `StoredImageTranscription`, `formatImageTranscription`, optional job field and optional LaTeX-request metadata.
- [ ] Run shared tests and typecheck; freeze contract before worker dispatch.

## Task 2 — Backend (backend worker)

Files: model Codex adapter/prompt/tests, domain ports/pipeline/store/tests, config/index/tests.

Consumes Task 1 contract. Produces `ProofModel.transcribeImage?(source: Extract<ProofRequest,{mode:"image"}>): Promise<ImageTranscription>` on the Codex adapter. Image pipeline requires recognition capability; it does not fall back to the old direct-image path. Non-Codex direct adapter APIs are not changed.

- [ ] Write failing tests showing distinct OCR and text calls, image only in first call, automatic stage order, early payload release, retained empty OCR result, and edited metadata.
- [ ] Implement bounded OCR prompt/schema/queue/deadline; preserve selected model and effort. Keep data-only prompts and safe error categories.
- [ ] Save transcription before translating, release image in finally on all OCR exits, and pass formatted text to initial generation and repairs.
- [ ] Run targeted tests, typecheck, and report changed files plus RED/GREEN evidence; do not commit/push/deploy.

## Task 3 — Site (frontend worker)

Files: `app/proof-api.ts`, new transcription helper/editor/tests, `app/page.tsx`, export helper/tests and limited styles.

Consumes the exact Task 1 JSON contract; optional job field is backward compatible.

- [ ] Add failing pure helper/export tests for editable fields, bounds, empty problem, text-only retry payload and legacy records.
- [ ] Add the mobile editor after OCR appears, with origin/uncertainty display. Keep edits stable across polling and disable retry while a job runs.
- [ ] Make edited retry a new LaTeX request carrying `imageTranscription`; no image upload on retry. Preserve current controls and deletion behavior.
- [ ] Include transcription in Markdown export. Run unit/build tests and report evidence; no Git mutations, browser operations or publication.

## Task 4 — Integration and release (root)

- [ ] Review each worker diff for spec compliance and code quality; run both full suites/builds.
- [ ] Perform mobile browser QA of recognition, editing, retry, history and legacy records.
- [ ] Publish exact backend source/image through GitHub Actions and exact Site source through Sites helper. Preserve access and secrets; respect native approvals.
- [ ] Verify actual new Railway digest. Submit the unchanged original photo and observe recognition → text-only generation → true LeanWeb result, retaining all evidence.
- [ ] Update delivery instructions and report only verified outcomes, distinguishing manual independent proof from Codex subscription acceptance.
