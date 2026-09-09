# LeanBridge AI — live activation runbook

> Last verified against public program information: 2026-09-10.
>
> This runbook is for the account holder operating the final hackathon deployment. Never paste provider keys into issues, pull requests, chat transcripts, screenshots, videos, or committed `.env` files.

## Goal

Produce one reproducible, evidence-backed live run of the exact submission build using:

1. Nebius Token Factory;
2. NVIDIA Nemotron;
3. optional Tavily grounding if pursuing the Tavily bonus;
4. real Lean 4 + mathlib verification.

The objective is evidence, not spending. Do not add a payment method solely for this smoke test if free program/trial credit is available.

## 1. Claim official builder credits

The Nebius x NVIDIA Global AI Hackathon rules point participants to the Nebius Builder Program:

- https://dev.nebius.com/builders

As of 2026-09-10, the public Builder Program page advertises:

- $25 Nebius Token Factory credit;
- $25 Tavily credit;
- Nebius Academy certification offer;
- office hours and builder-community access.

The program is described as free to join for eligible members during its early preview. Benefits and availability can change, so verify the current program page before claiming.

Nebius Token Factory billing documentation also documents promo-code redemption without first adding billing information or a bank card:

- https://docs.tokenfactory.nebius.com/other-capabilities/billing

Do not infer that every Builder Program redemption flow is identical to the generic promo-code flow; follow the instructions supplied with the actual credit.

## 2. Create service keys privately

### Nebius Token Factory

Use the Token Factory console:

- https://tokenfactory.nebius.com/

Create a dedicated API key for the hackathon deployment. Keep the key in the deployment provider's secret/environment-variable store only.

Required server-side variables:

```dotenv
MODEL_PROVIDER=nebius
NEBIUS_API_KEY=<set privately in deployment secret storage>
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
NEBIUS_BASE_URL=https://api.tokenfactory.us-central1.nebius.com/v1/
```

Before the final demo, confirm the current Token Factory catalog still exposes the configured NVIDIA model and endpoint. If the provider changes the canonical model identifier or endpoint, update the branch through a tested code/config change rather than silently changing the demo environment.

### Tavily — optional bonus path

If pursuing the Best Use of Tavily bonus, create/claim the Tavily credential through the official Builder Program flow and configure it only in deployment secret storage:

```dotenv
TAVILY_GROUNDING_ENABLED=true
TAVILY_API_KEY=<set privately in deployment secret storage>
```

If Tavily is not going to be demonstrated with a real runtime call, leave grounding disabled and do not claim the bonus integration as live-verified.

## 3. Configure the production backend

The production container expects a strong backend bearer token in addition to provider credentials:

```dotenv
LEANBRIDGE_BACKEND_TOKEN=<generate privately in deployment secret storage>
```

Do not reuse a provider key, personal password, bank-related credential, or GitHub token as the backend token.

The Docker image already pins the Lean/mathlib project and cloud-mode settings. Do not override the project path with a user-controlled directory in the public demo.

## 4. Verify capability state before spending model credit

First check the public health endpoint:

```bash
curl -fsS https://<deployment-host>/api/health
```

Expected shape:

```json
{"ok":true,"service":"leanbridge"}
```

Then inspect the authenticated public runtime configuration through the same trusted proxy/backend path used by the UI. Confirm that it reports:

- provider: `nebius`;
- model: the NVIDIA Nemotron model actually configured;
- `grounding.tavily: true` only if Tavily is genuinely enabled;
- Lean mode: `cloud`.

Do not record or expose the backend bearer token while collecting this evidence.

## 5. Verify Lean independently of the model

Before making an inference call, run the authenticated readiness probe:

```bash
curl -fsS \
  -H "Authorization: Bearer <backend-token>" \
  https://<deployment-host>/api/ready
```

Expected successful response:

```json
{"ok":true,"lean":"ready"}
```

This confirms that the deployed container can compile a probe theorem with the real Lean environment before model credit is spent.

## 6. Run the smallest end-to-end proof first

Start with Candidate A from `docs/demo-inputs.md`:

```text
Let a and b be natural numbers. Prove that a + b = b + a.
```

Reasons to start here:

- the semantic target is unambiguous;
- the output is easy to inspect;
- the expected mathlib concept is recognizable;
- the request is small, limiting inference and search cost;
- it is sufficient to prove that the external-service → Lean path works.

If Tavily grounding is enabled, verify that the UI shows `Tavily mathlib grounding` before submitting. A visible badge alone is not evidence of a successful API call; retain provider-side usage/log evidence as well.

## 7. Check semantic fidelity, not just a green kernel result

For Candidate A, the generated theorem should faithfully represent:

```lean
∀ a b : Nat, a + b = b + a
```

A Lean-verified theorem that weakens, changes, or omits the user's statement is not a successful formalization demo. Inspect the theorem statement before selecting the run for the video.

## 8. Capture a repair example only if it occurs naturally

After the minimal end-to-end run succeeds, try Candidates B and C from `docs/demo-inputs.md` to look for a reproducible compiler-diagnostic repair cycle.

Never deliberately insert a fake error and present it as model-generated failure. If the first model attempt verifies every time, demonstrate the genuine first-pass success and keep the repair mechanism visible in architecture/tests rather than fabricating a live repair story.

## 9. Record a sanitized evidence receipt

For each candidate run, record a private receipt containing only non-secret facts:

```text
submission_commit=<git SHA>
deployment_url=<public URL>
provider=nebius
model=<actual NVIDIA model id>
tavily_enabled=true|false
tavily_runtime_call_confirmed=true|false
lean_ready=true|false
proof_candidate=A|B|C
model_calls=<count if available>
lean_compile_attempts=<count>
first_attempt_verified=true|false
final_status=verified|failed
wall_clock_ms=<measured value>
semantic_fidelity_checked=true|false
```

Do not put API keys, bearer tokens, billing identifiers, card information, raw secret-store screenshots, or personal account identifiers in the receipt.

## 10. Final evidence gates

Before changing the repository to public or submitting on Devpost, verify all of the following against the same commit:

- GitHub CI passes tests, strict TypeScript checking, and production build;
- the deployed UI identifies `Nebius · NVIDIA Nemotron`;
- a real Token Factory inference call succeeds;
- real Lean/mathlib readiness succeeds;
- at least one generated theorem is both semantically faithful and kernel-verified;
- if the Tavily bonus is claimed, a real functional Tavily API call succeeds in the submitted solution;
- any repair cycle shown in the video genuinely occurred;
- the repository contains no secrets;
- the public demo does not require viewers to know a private credential;
- the final video is public and no longer than three minutes;
- the submission discloses that LeanBridge existed before the hackathon and identifies the substantial hackathon-period work.

## Stop conditions

Do not continue a live test if:

- the service requests a payment/top-up that the account holder did not intend to authorize;
- the configured model is unavailable and the replacement has not been verified against the hackathon requirements;
- a secret appears in logs, screenshots, browser developer tools, or the generated proof output;
- the deployed Lean readiness probe fails;
- the generated theorem materially changes the source statement.

Resolve the cause first, then repeat the smallest smoke test.
