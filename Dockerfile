ARG NODE_VERSION="jod"
ARG ALPINE_VERSION="3.21"
ARG BUN_VERSION="1.3.0"
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH=amd64
ARG DOCKER_PLATFORM=linux/amd64

# Use BUILDPLATFORM if set (BuildKit), otherwise use DOCKER_PLATFORM, fallback to linux/amd64
FROM --platform=${BUILDPLATFORM:-${DOCKER_PLATFORM:-linux/amd64}} oven/bun:${BUN_VERSION}-alpine AS bun_base
FROM --platform=${BUILDPLATFORM:-${DOCKER_PLATFORM:-linux/amd64}} node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node_base

# ---- BUILDER BASE ----
FROM bun_base AS builder_base

WORKDIR /deps

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
ENV TARGETARCH=${TARGETARCH}

RUN apk add --no-cache curl python3 make g++ git nodejs npm

RUN echo "Building for ${TARGETARCH:-amd64}"
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-aarch64"; \
    elif [ "${TARGETARCH}" = "amd64" ] || [ -z "${TARGETARCH}" ]; then \
      curl -L -o docker-binary "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64"; \
    else \
      echo "ERROR: Unsupported TARGETARCH: ${TARGETARCH}" && exit 1; \
    fi

RUN chmod +x docker-binary && \
    ls -lh docker-binary && \
    echo "Binary downloaded successfully for ${TARGETARCH:-amd64}" && \
    (./docker-binary version > /dev/null 2>&1 && echo "Binary verification passed" || echo "Warning: Binary verification failed, but continuing...")

# ---- RUNNER BASE ----
FROM node_base AS runner_base

RUN apk add --no-cache curl openssl git docker-cli

# ---- BUILDER ----
FROM builder_base AS builder

ARG TIPI_VERSION
ARG LOCAL

ENV SENTRY_RELEASE=${TIPI_VERSION}
ENV TIPI_VERSION=${TIPI_VERSION}
# Don't set NODE_ENV=production yet - we need devDependencies for the build
# NODE_ENV=production will be set for the build step (needed for vite config)

WORKDIR /app

COPY ./bun.lock ./
COPY ./package.json ./
COPY ./packages/backend/package.json ./packages/backend/package.json
COPY ./packages/frontend/package.json ./packages/frontend/package.json
COPY ./packages/common/package.json ./packages/common/package.json
COPY ./packages/frontend/public ./packages/frontend/public

# Install dependencies (including devDependencies needed for build)
# Skip postinstall scripts (git hooks not needed in Docker)
RUN bun install --frozen-lockfile --ignore-scripts && \
    echo "Verifying @react-router/dev is installed..." && \
    ls -la node_modules/@react-router/dev/bin.js && \
    ls -la node_modules/.bin/react-router || echo "WARNING: react-router binary not found"

COPY ./turbo.json ./turbo.json
COPY ./tsconfig.json ./
ARG CACHE_BUST=1
COPY ./packages ./packages

# Set NODE_ENV=production for the build (needed for vite.config.ts)
ENV NODE_ENV=production

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
RUN chmod +x /usr/local/bin/docker-compose && \
    ls -lh /usr/local/bin/docker-compose
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/backend/dist ./

# Assets
COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/backend/src/modules/i18n/translations ./assets/translations
COPY --from=builder /app/packages/backend/src/swagger.json ./packages/backend/src/swagger.json
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

RUN mv main.js main.mjs

CMD ["node", "./main.mjs"]
