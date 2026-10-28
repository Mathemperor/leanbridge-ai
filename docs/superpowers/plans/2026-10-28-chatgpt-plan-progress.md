# SDD ledger — plan: docs/superpowers/plans/2026-10-28-chatgpt-plan.md

## Final status — complete, 2026-10-28

Tasks 1–4 are implemented, reviewed, published and accepted on the existing production branch. The entries below this section preserve earlier checkpoints; their pending labels are superseded by this final status.

- Backend runtime revision: `5336ffa016f9664e98b06421e7e2c1847d04b2de`. Exact production image: `ghcr.io/mathemperor/leanbridge-ai@sha256:6486ec6530cc242ed5734a0b4dde017a3d78448c45bad73209662b6944220d0f`. Actual image assertions confirm neither Codex CLI nor a local Lean compiler is installed. GitHub Actions run `40645541974` succeeded.
- Final backend verification: 285 tests, typecheck and build passed, including 43 session tests. Final frontend verification: 93 unit tests, 2 rendered HTML tests, typecheck and build passed. No runtime changes followed these checks; final follow-up is documentation only.
- Site revision 15 is published from frontend `99e509d8d57994977994a55b24d01356d35b4d36`. Owner-only APIs, model/effort selection, editable image text/LaTeX, history and deletion remain available. Mobile 304 px layout has no horizontal overflow.
- Actual official HTTPS consent and loopback form succeeded. The desktop helper was stopped; production retained its grant across restart. Request-driven upstream refresh extended the observed access expiry from `2026-10-28T09:14:33.822Z` to `2026-10-28T10:13:08.240Z`, without user login. A second restart retained the rotated grant and same new expiry. A subsequent actual Astra High request generated a natural-number proof and LeanWeb accepted it in 4,492 ms.
- Production real LeanWeb accepted correct Mathlib proofs and rejected a false proof; the production entry rejected `sorry` with HTTP 400. Actual Astra Max text generation also compiled successfully. No API-key billing fallback was used.
- The original uploaded analysis problem was transcribed into editable question/solution text and LaTeX. Astra Max OCR hit the 180-second timeout; Astra High OCR succeeded. Initial formalization and three repairs missed `Mathlib.Analysis.Calculus.Deriv.MeanValue`. An explicitly marked import hint plus that model's own prior draft was added to the editable solution; the next actual subscription generation passed production LeanWeb in 5,361 ms, with only `propext`, `Classical.choice`, `Quot.sound` and no `sorryAx`. This is an assisted retry, not an unassisted first-pass claim. The statement and half-line/right-derivative assumptions were preserved. Independent hand-written code was not substituted for model output.
- The accepted original proof was restored from owner-only durable history after the second restart. User history was not deleted during acceptance.
- Production memory: 30-second samples during recognition, generation, repair, compilation and refresh observed a maximum of 55,439,360 bytes; this is a sampled maximum. CI's actual container cgroup peak was 44,019,712 bytes under its 192 MB compilation-test budget, with no OOM.
- Railway remains on the exact accepted image, one sfo replica and the existing private 500 MB `/data` volume, with no staged changes. OAuth storage and model billing scope were not expanded during acceptance.

Disposition: retain the already published `codex/subscription-cloud-20261021` branch and existing dedicated clone, as authorized for this delivery; do not merge or remove them. The final ledger is committed here before removing this plan's ignored scratch workspace. Private screenshots, proof exports, original image and credentials are not included in this public ledger. Full private evidence and the mobile handoff are kept in the task's `outputs/LeanBridge` directory.

## Earlier checkpoints

Base: f53cf73583dad4fce2065d1af0a7ee02f5ff50ce, dedicated existing task clone/branch, clean before starting.
Design direction is explicitly authorized by latest user instruction; do not ask them to choose the route again. Durable storage and official bootstrap protocol are builder choices, documented in the spec.
Task 1: implemented, 35 focused session tests passed; pending review/live cloud acceptance.
Task 2: model/stream implemented, 32 focused tests passed. Runtime/config/router/Docker wired by root; bootstrap route tests RED 401→GREEN. Old Docker CLI assertion updated to new requirement. Full final suite pending.
Task 3: bridge 3 security HTTP tests RED→GREEN. Sites frontend 93 unit +2 HTML tests, typecheck and verified build passed. Source freshly opened through native helper at same project, owner/public retained. Whole-change review/publication and real HTTPS form QA pending.
Task 4: pending.
Current Railway: exact prior image d81062d0, single sfo replica, sleep enabled, /data 500 MB; no staged changes. Plugin OAuth lists variable names only; do not attempt to recover its hidden bearer token. Use existing owner-authenticated workbench to initiate ticket setup.
Production retains its prior CLI grant until new auth is verified; no API-key use is permitted by this migration.

Preflight scan:
| Tasks | Shared boundary | Result |
| --- | --- | --- |
| 1 internal | session tests vs persistence/refresh implementation | aligned; scope/types/rotation and safe errors tested |
| 2 internal | stream/model tests vs runtime removal | aligned; partial/failed streams reject, CI will check actual missing CLI |
| 3 internal | bridge/frontend contracts | aligned setup fields, fixed callback and POST-body ticket |
| 4 internal | release/evidence | actual image/real provider/Lean checks required, no fixture acceptance |
| 1–2 | accessToken/catalog/status methods | structural interface fixed in agent brief, no CLI import |
| 1–3 | pending setup and code/state/ticket callback | status must retain setup for polling; repeated starts reuse ticket; corrected with tests |
| 2–3 | public provider and endpoints | keep codex provider for current worker, additive subscriptionTransport |
| 1–4 | mounted encrypted auth across deployment | preserve /data volume and single sfo replica, no old grant deletion |
Ruling: Bash skill helper is unavailable on this Windows installation; created the same plan-scoped self-ignored workspace with native PowerShell. No sibling plan files were changed.
Ruling: Permit browser Origin:null on the loopback form only after its unguessable ticket is validated with the pinned HTTPS backend; modern HTTPS-to-loopback form origin can serialize as opaque. Other untrusted origins and off-service URLs are rejected, cookie/state and cloud nonce/PKCE still required. This costs reliance on the short-lived ticket rather than Origin alone for opaque browser forms.
Builder check: fresh reviewer found nothing important unanswered. Native Railway read confirms live prior image, sleeping service, no staged changes; OAuth variable reads provide names only and are respected.

Final review: completed by a fresh reviewer after the earlier reviewer was interrupted; no second fix/re-review loop.
Final: fixed rotated-refresh persistence failure — retain the validated replacement and retry its durable write before any subsequent refresh; failed revocation writes cannot restore in-memory access. Filesystem fault-injection tests RED→GREEN; full suite pending final recovery-code fix.
Final: fixed callback polling race — consumed setup remains explicitly pending/completing during exchange and private save; held-exchange test RED idle→GREEN pending then connected. Frontend retains polling without offering the consumed ticket.
Final: fixed catalog contract — actual subscription models[].slug and visibility replace API-key-style data[].id; actual-shape fixture RED→GREEN, hidden models not admitted.
Final: fixed terminal refresh recovery — five documented terminal token codes now retain the issued client ID and permit new OAuth; five RED regressions before fix, final green run pending.
Final: minor (deferred): 403 policy/region and subscription-specific stream error codes currently use conservative generic/reconnect wording; credentials are preserved and no API-key fallback occurs.
Verification before last recovery fix: backend 280/280 tests, typecheck/build green; frontend 93 unit + 2 rendered tests, typecheck/build green. Release and real production acceptance are still pending.
Task 1: complete implementation and reviewed recovery fixes, 43 session tests; final backend suite 285/285 passed, typecheck/build passed.
Task 2: complete implementation and reviewed catalog correction; final backend suite 285/285 passed, typecheck/build passed. Actual CI image check is a release gate.
Task 3: complete implementation, 93 frontend unit +2 rendered tests and typecheck/build passed after completing-state integration; actual HTTPS-to-loopback form remains a production acceptance gate.
Task 4: review complete, all Important findings covered by RED→GREEN tests and green final suites; native release and real acceptance pending.
Release revision: first CLI-free image cd4e8af/c3ca96de passed actual container tests (43,409,408 bytes peak; no OOM), and Site v14 published successfully. Railway Apply 8 changes is staged; native deployment cancelled by client as user not approved. No permission changes or bypass.
Ruling: replace the original fixed port 59255 with verified available 1455 — actual startup failed EACCES and Windows lists 59176–59275 as reserved; official SIWC sign-in documentation explicitly permits returning sign-in to change only the loopback port. Keep all destination/state/cookie/ticket protections and the same client ID. Cost if wrong: authorization fails closed and needs a new attempt; no token export or new grant scope. Session and frontend endpoint tests observed RED before this change.
