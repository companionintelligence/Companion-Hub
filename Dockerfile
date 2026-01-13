ARG NODE_VERSION="jod"
ARG ALPINE_VERSION="3.21"
ARG BUN_VERSION="1.3.0"

FROM oven/bun:${BUN_VERSION}-alpine AS bun_base
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node_base

# ---- BUILDER BASE ----
FROM bun_base AS builder_base

WORKDIR /deps

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
ENV TARGETARCH=${TARGETARCH}

RUN apk add --no-cache curl python3 make g++ git

RUN echo "Building for ${TARGETARCH}"
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-aarch64"; \
      elif [ "${TARGETARCH}" = "amd64" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64"; \
      fi

RUN chmod +x docker-binary

# ---- RUNNER BASE ----
FROM node_base AS runner_base

RUN apk add --no-cache curl openssl git docker-cli

# ---- BUILDER ----
FROM builder_base AS builder

ARG TIPI_VERSION
ARG LOCAL

ENV SENTRY_RELEASE=${TIPI_VERSION}

WORKDIR /app

COPY ./bun.lock ./
COPY ./package.json ./
COPY ./packages/backend/package.json ./packages/backend/package.json
COPY ./packages/frontend/package.json ./packages/frontend/package.json
COPY ./packages/common/package.json ./packages/common/package.json
COPY ./packages/frontend/public ./packages/frontend/public

# Install dependencies
RUN bun install --frozen-lockfile

COPY ./turbo.json ./turbo.json
COPY ./tsconfig.json ./
ARG CACHE_BUST=1
COPY ./packages ./packages
RUN bun run build

RUN echo "TIPI_VERSION: ${SENTRY_RELEASE}"
RUN echo "LOCAL: ${LOCAL}"

RUN bun run bundle
# Upload sourcemaps to Sentry if token is provided (non-blocking - won't fail build)
RUN --mount=type=secret,id=sentry_token,env=SENTRY_AUTH_TOKEN \
  if [ "${LOCAL}" != "true" ] && [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then \
    cd ./packages/backend && \
    bun run sentry:sourcemaps || echo "Warning: Sentry sourcemap upload failed, continuing build..."; \
  else \
    echo "Skipping Sentry sourcemap upload (LOCAL=${LOCAL:-false}, token not provided)"; \
  fi

# ---- RUNNER ----
FROM runner_base AS runner

ENV NODE_ENV="production"

WORKDIR /app

# Use build cache for npm install
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save --omit=dev argon2 class-transformer

COPY --from=builder_base /deps/docker-binary /usr/local/bin/docker-compose
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/backend/dist ./

# Assets
COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/backend/src/modules/i18n/translations ./assets/translations
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

RUN mv main.js main.mjs

CMD ["node", "./main.mjs"]
