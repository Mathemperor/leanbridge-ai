# Subscription Fast capability investigation

The user wants actual Fast processing in LeanBridge, validated by real subscription requests and real LeanWeb compilation. API-key billing, a Railway Codex CLI, changed model/effort, fake client identity and repeated unchanged phone tests are excluded.

Observed production: Astra / Max and GPT-5.6 Sol / Max both accept `priority` but report actual `default`; literal `fast` returns HTTP 400. The official local client advertises tier id `priority`, but its catalog may be cached and is not proof of the cloud grant's eligibility.

## Approach

Use the existing explicit, one-shot release-check mechanism for a new `tier-capabilities-v1` profile. Read the actual cloud grant's model catalog and retain only fixed tier identifiers for the two tested models. Then make at most three serial, independent Astra / Max requests using the same fixed natural-number prompt and no structured-output parameter: explicit default, priority, literal fast. Validate generated Lean with the existing source validator and real configured LeanWeb verifier. This tests the format hypothesis without changing normal application behavior.

Alternatives considered: repeating the phone model test adds no new evidence; first-party client impersonation or private endpoints violate the existing integration boundary; moving the CLI back to Railway violates the user's architecture. A bounded diagnostic on the already-authorized grant is the remaining useful control.

## Constraints

- No inference unless a valid ID, future deadline within 24 hours and recognized profile are supplied.
- Claim the ID in the existing private volume before catalog/inference; the same ID never runs twice after restart.
- At most three independent requests, each bounded by 90 seconds and the overall startup deadline; no retries or repairs.
- Use existing OAuth session refresh and only `https://api.openai.com/v1/models` and `/v1/responses`; `store:false`, `stream:true`.
- Ordinary proof requests, models, efforts, speed routing, auth persistence and history remain unchanged.
- Logs contain categorical metadata and compiler status/duration only; never tokens, raw catalog descriptions, provider prose, generated proof text, or user data.
- A missing Fast tier or actual `default` is evidence of no confirmed Fast, never success.
- Stop after shared auth, quota, network/model errors or compiler infrastructure failures. A request-level 400 may continue as an independent wire-format control.
- After real results, clear all temporary check variables and preserve the claim marker.

## Acceptance

Unit tests pin one-shot behavior, privacy, exact request shape, same model/effort, deadline/admission failures and actual-tier retention. Build a container in GitHub Actions and run real positive/negative/sorry LeanWeb checks before staging its immutable image. Runtime controls remain pending until that exact image is deployed and terminal results are read.
