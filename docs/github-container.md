# Build on GitHub, run on Railway

The `Build verified LeanBridge container` workflow runs on pushes to `codex/subscription-cloud-20261021` that change its image inputs. It builds the existing Dockerfile on Ubuntu with a 90-minute job timeout, runs application checks, verifies the real image at 512 MiB and one CPU, and publishes to `ghcr.io/mathemperor/leanbridge-ai` only after success.

Actions uses its short-lived `GITHUB_TOKEN` with `contents: read` and `packages: write`. No Railway token, backend shared token, production Codex authorization, or model API key is required in repository secrets. Container verification uses a disposable random local token and never invokes model generation.

## First publication

1. Check the entire workflow succeeds and inspect the `container-verification` artifact. After publication, the final step counts compressed registry blobs and fails above a conservative 4,000,000,000-byte gate. A failed size check leaves an image in GHCR but does not mark it ready for Railway. Actual Railway admission remains a separate check; the uncompressed local image size is also recorded.
2. GHCR packages are private by default even when the source repository is public. In this package's GitHub settings, make the application image public so Railway Free can pull it without registry credentials. This image contains public application code and public Lean/Mathlib dependencies; production credentials remain in Railway variables and `/data`.
3. Copy the exact `ghcr.io/mathemperor/leanbridge-ai@sha256:...` reference printed in the successful workflow summary. Do not use a digest from another run or the old Railway source build.
4. Change the existing Railway service's source to this image. Preserve the domain, variables, sleep setting, region, and `/data` volume. Set `/api/health` with a 60-second healthcheck and `ON_FAILURE` / 3 restart retries explicitly: image-source deployments do not read the repository's `railway.json`.
5. Deploy the staged image source and verify its actual image digest. There should be no Lean/Mathlib source-build stage on Railway.

## Acceptance and later releases

The workflow stores compiler diagnostics and memory observations as an artifact. These are GitHub-container checks; production Railway acceptance still requires a real valid Mathlib proof, rejection of a false proof and `sorry`, subscription-generated proof with the chosen model/effort, and mobile history reopening.

Later commits produce fresh tags and digests. Update Railway to a verified digest after reviewing the new run. Rolling back uses a previously verified digest while retaining `/data`; never remove the service or its auth volume to change an image.

Reference: [GitHub container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Railway private registry requirements](https://docs.railway.com/builds/private-registries), [Docker test before push](https://docs.docker.com/build/ci/github-actions/test-before-push/).
