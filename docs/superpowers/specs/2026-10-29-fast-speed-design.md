# LeanBridge optional Fast speed

The user requests a speed option described as 1.5x in the existing mobile application. Implement official Fast routing while keeping the existing model, reasoning effort, subscription authorization, remote LeanWeb verification, history and deletion behavior. This is an explicit feature request; routine implementation choices use the existing architecture.

## Approach

Use the documented Responses `service_tier` parameter. Normal tasks use Standard; opting into Fast sends `fast` for image recognition, formalization and repairs. Do not approximate speed by reducing reasoning effort, switching models, shortening proofs, dropping verification or restoring CLI/API-key billing. The current single-request queue remains unchanged in this bounded feature.

The user-facing selector is `速度` with `标准` and `快速 · Fast`. For GPT-5.6, the Fast option may say `约 1.5×`; for other models show Fast without promising a fixed multiplier. Explain the subscription consumption multiplier (currently approximately 2.5x Standard included usage) before submission, and that end-to-end proof time is not guaranteed. Default to Standard, remember the browser's choice and freeze the selection for active jobs. The existing subscription flow remains the only production billing route.

## Contracts

- Optional `speed: "standard" | "fast"` in proof requests/settings, with no new required field in old saved records. Legacy requests remain accepted without a speed property.
- New backend catalog advertises `speeds` and `defaultSpeed`. A new frontend talking to the old backend disables Fast and omits the property; it must not present a working speed control before the backend supports it.
- Explicit Standard sends `service_tier: "default"`; Fast sends `service_tier: "fast"`. Missing speed preserves existing request behavior. Preserve model and reasoning fields exactly.
- Capture only known `service_tier` values (`default`, `fast`, `priority`, `auto`) from completed upstream Responses metadata, never from generated proof JSON. Store this optional metadata on recognition/translation; show requested speed and actual tier in result/export. If the server downgrades to Standard, display it; if metadata is missing, say it was not returned.
- Fast denial is explicit. Parse a bounded error body for categorical code/param only; `service_tier` unsupported errors receive a clear speed-specific message. No silent retry in another tier, model, account or billing route.
- Job settings survive image-to-text conversion, editable-recognition retry, automatic repair, cloud history and export. Manual Lean compilation has no model speed setting.

## Verification and release

Tests first: backend HTTP payload for Standard/Fast/missing speed, image and repair propagation, queue isolation, effective-tier capture including downgrade, bounded/safe provider errors; frontend settings migration, old-backend gating, request validation, Worker forwarding, history/export rendering. Run both full suites and typechecks/builds once after implementation. Publish the exact verified source and digest, preserve the private `/data` grant and Sites audience/owner checks. Confirm a real subscription Fast response and LeanWeb compilation when production owner access permits; record access/approval blockers instead of claiming a test double is live acceptance.

Official references checked 2026-10-29: https://learn.chatgpt.com/docs/agent-configuration/speed ; https://developers.openai.com/api/docs/guides/fast-mode ; https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery . Codex 1.5x guidance is GPT-5.6-specific and is not an Astra latency guarantee.
