FROM node:22-bookworm-slim AS application-build

RUN apt-get update \
  && apt-get install --yes --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && mkdir -p /app/dist/native \
  && gcc -O2 -Wall -Wextra src/native/leanbridge-evict-cache.c -o /app/dist/native/leanbridge-evict-cache

FROM node:22-bookworm-slim AS lean-environment

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl git libgmp10 zstd \
  && rm -rf /var/lib/apt/lists/*

ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh \
  | sh -s -- -y --default-toolchain leanprover/lean4:v4.24.0

WORKDIR /app
COPY lean-project ./lean-project
# Elan installs the pinned toolchain lazily. Cache that download in its own layer.
RUN set -eu; \
  cd lean-project; \
  attempt=1; \
  until lake --version; do \
    if [ "$attempt" -ge 5 ]; then exit 1; fi; \
    sleep 10; \
    attempt=$((attempt + 1)); \
  done

RUN set -eu; \
  export LEAN_NUM_THREADS=2 RAYON_NUM_THREADS=2 CURL_HOME=/tmp/leanbridge-curl; \
  mkdir -p "$CURL_HOME"; \
  printf '%s\n' 'parallel-max = 4' 'retry = 5' 'retry-all-errors' 'connect-timeout = 20' > "$CURL_HOME/.curlrc"; \
  cd lean-project; \
  attempt=1; \
  until lake -v exe cache get; do \
    if [ "$attempt" -ge 5 ]; then \
      echo "Lean dependency/cache download failed after 5 attempts." >&2; \
      exit 1; \
    fi; \
    echo "Retrying Lean dependency/cache download in 10 seconds (attempt $attempt of 5)."; \
    sleep 10; \
    attempt=$((attempt + 1)); \
  done; \
  lake env lean -j2 LeanBridge/Basic.lean; \
  lake env printenv LEAN_PATH > .lean-path; \
  elan which lean > .lean-bin; \
  find /root/.cache/mathlib -maxdepth 1 -type f -name '*.ltar' -delete

# Reuse the large toolchain and Mathlib layers directly. Copying and changing
# permissions on them again can exhaust the hosted builder's deadline.
FROM lean-environment AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates libgmp10 gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 leanbridge \
  && useradd --create-home --uid 10001 --gid leanbridge --shell /usr/sbin/nologin leanbridge

RUN npm install --global @openai/codex@0.163.0 && npm cache clean --force

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=96 --expose-gc"
ENV CLOUD_MODE=true
ENV DEMO_MODE=false
ENV LEAN_PROJECT_PATH=/app/lean-project
ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"
ENV LAKE_COMMAND=/usr/local/bin/leanbridge-lake-env
ENV CODEX_HOME=/data/codex

WORKDIR /app

COPY --chmod=0444 package.json package-lock.json ./
COPY --chmod=0555 --from=application-build /app/node_modules ./node_modules
COPY --chmod=0555 --from=application-build /app/dist ./dist
COPY --chmod=0555 --from=application-build /app/dist/native/leanbridge-evict-cache /usr/local/bin/leanbridge-evict-cache
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=0555 docker-lean-wrapper.sh /usr/local/bin/leanbridge-lake-env
COPY --chmod=0555 docker-cloud-start.sh /usr/local/bin/docker-cloud-start.sh

# Inherited files are owned by root. Verify that the service account cannot
# modify them, then compile through the same bounded wrapper used in production.
RUN set -eu; \
  writable="$(gosu leanbridge find /opt/elan /app/lean-project -writable -print -quit)"; \
  if [ -n "$writable" ]; then \
    echo "Lean runtime files must be read-only for the service account." >&2; \
    exit 1; \
  fi; \
  cd /app/lean-project; \
  gosu leanbridge /usr/local/bin/leanbridge-lake-env env lean LeanBridge/Basic.lean

EXPOSE 4310

ENTRYPOINT ["/usr/local/bin/docker-cloud-start.sh"]
CMD ["node", "dist/server/index.js"]
