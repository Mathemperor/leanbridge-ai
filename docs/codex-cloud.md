# Private cloud workbench with Codex subscription authentication

The mobile Site uses ChatGPT identity and an explicit owner allowlist. Its server
holds the separate backend bearer token. Railway runs the official Codex CLI
0.163.0 and real Lean/mathlib 4.24.0. Set MODEL_PROVIDER=codex,
CODEX_MODEL=gpt-6-astra and CODEX_REASONING_EFFORT=high. No inference API key is
read by this provider, and it never falls back to API billing.

Mount a private Railway volume at /data. Only /data/codex stores the CLI login
cache. The root entrypoint initializes its ownership and immediately drops to
the existing leanbridge account. Never commit, log, or include that directory
in source archives. Revoke the cloud Codex session from the OpenAI account when
decommissioning this service.

Authenticated GET /api/codex/status reports a boolean connection state.
Authenticated POST /api/codex/login starts the official CLI device login and
returns only the official authorization URL, short-lived device code, and
expiry. The owner completes the OpenAI login themselves. Logs, tokens, and the
credential cache never reach the browser. ChatGPT security settings may require
enabling device-code login. A connected status is not an entitlement or quota
guarantee: an actual successful generation confirms model access.

Codex runs ephemeral, serialized jobs with a read-only sandbox, disabled shell
tool, structured JSON output, bounded runtime and output, and an allowlisted
environment without API keys or application secrets. Images use temporary files
removed after each run. Lean compilation remains separate from model generation.
The sanitizer disallows proof placeholders and unsafe metaprogramming.

POST /api/proofs/manual accepts supplied Lean code and performs actual
compilation without invoking any model. The resulting record explicitly marks
the source as manual. Valid and invalid theorem integration checks must inspect
the real compiler exit code and diagnostics. Unit fakes are not proof of a live
deployment's compiler or subscription functionality.

Official references:
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/non-interactive-mode
