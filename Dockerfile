FROM node:22-bookworm-slim AS application-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# OAuth subscription inference and LeanWeb compilation both run remotely.
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 leanbridge \
  && useradd --create-home --uid 10001 --gid leanbridge --shell /usr/sbin/nologin leanbridge

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=96 --expose-gc"
ENV CLOUD_MODE=true
ENV DEMO_MODE=false
ENV MODEL_PROVIDER=codex
ENV LEAN_VERIFIER=leanweb
ENV LEAN_TIMEOUT_MS=120000
ENV CHATGPT_PLAN_AUTH_DIR=/data/chatgpt-plan

WORKDIR /app
COPY --chmod=0444 package.json package-lock.json ./
COPY --chmod=0555 --from=application-build /app/node_modules ./node_modules
COPY --chmod=0555 --from=application-build /app/dist ./dist
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=0555 docker-cloud-start.sh /usr/local/bin/docker-cloud-start.sh
EXPOSE 4310
ENTRYPOINT ["/usr/local/bin/docker-cloud-start.sh"]
CMD ["node", "dist/server/index.js"]
