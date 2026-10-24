# GitHub-built LeanBridge container

The user selected GitHub Actions to remove Lean/Mathlib image building from Railway's deployment path. Keep the existing mobile Site, backend behavior, Codex subscription-only inference, and `/data` login volume.

## Approach

Build the existing Dockerfile on a standard GitHub-hosted Ubuntu runner with a 90-minute job timeout. Run application checks, load the Linux amd64 image, and verify the real container at 512 MiB / one CPU before publishing it to GHCR. Tag by source commit and workflow run; deploy an exact registry digest in Railway. Use only the job-scoped `GITHUB_TOKEN` for publication. No production credentials or Codex login files enter Actions or the image.

The source repository is already public. Railway Free cannot authenticate to a private registry, so the built GHCR package must be public before switching Railway to it. Its visibility is checked independently of repository visibility. Keep the currently running backend until a usable image and staged deployment are ready.

## Alternatives

- Railway source builds were retried and timed out again; the user explicitly replaced this route.
- A private registry would require a Railway plan upgrade and persistent registry credentials; neither is needed for this public-source application.
- GitHub Actions plus public GHCR is the selected route; no automatic Railway credential is introduced into Actions.

## Acceptance

1. Workflow syntax is validated; actions are pinned to verified upstream commit hashes.
2. Application tests, image build, and constrained-container checks pass. Checks cover real Mathlib/Nat proofs, incorrect proof rejection, sorry rejection, protected endpoints, and the model catalog.
3. A pushed image has source-revision metadata and an exact digest; anonymous registry access is confirmed.
4. Railway deploys that digest without a source build and retains environment variables, domain, and login volume.
5. Real Railway Lean acceptance and a subscription-generated proof using a nondefault model/effort remain mandatory. GitHub checks do not replace production acceptance.
