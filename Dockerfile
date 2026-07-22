FROM node:22-bookworm-slim AS application-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
RUN cd lean-project \
  && lake exe cache get \
  && lake env lean LeanBridge/Basic.lean

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates libgmp10 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 leanbridge \
  && useradd --create-home --uid 10001 --gid leanbridge --shell /usr/sbin/nologin leanbridge

ENV NODE_ENV=production
ENV CLOUD_MODE=true
ENV DEMO_MODE=false
ENV LEAN_PROJECT_PATH=/app/lean-project
ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=application-build /app/node_modules ./node_modules
COPY --from=application-build /app/dist ./dist
COPY --from=lean-environment /opt/elan /opt/elan
COPY --from=lean-environment /app/lean-project ./lean-project
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod -R a-w /app /opt/elan

EXPOSE 4310

USER leanbridge

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
