ARG NODE_VERSION="jod"
ARG ALPINE_VERSION="3.21"
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH=amd64
ARG DOCKER_PLATFORM=linux/amd64

FROM --platform=${BUILDPLATFORM:-${DOCKER_PLATFORM:-linux/amd64}} node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node_base

# ---- BUILDER BASE ----
FROM node_base AS builder_base

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /deps

ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
ENV TARGETARCH=${TARGETARCH}

RUN apk add --no-cache curl python3 make g++ git

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

RUN apk add --no-cache curl openssl git docker-cli dmidecode

# ---- BUILDER ----
FROM builder_base AS builder

ARG TIPI_VERSION
ARG LOCAL

ENV TIPI_VERSION=${TIPI_VERSION}

WORKDIR /app

COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./package.json ./
COPY ./packages/backend/package.json ./packages/backend/package.json
COPY ./packages/frontend/package.json ./packages/frontend/package.json
COPY ./packages/common/package.json ./packages/common/package.json
COPY ./packages/frontend/public ./packages/frontend/public

# Install dependencies (including devDependencies needed for build)
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY ./turbo.json ./turbo.json
COPY ./tsconfig.json ./
ARG CACHE_BUST=1
COPY ./packages ./packages

# Set NODE_ENV=production for the build (needed for vite.config.ts)
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"

# Frontend bundle reads portal URL from CI_CLOUD_URL (injected via Vite define)
ARG CI_CLOUD_URL=""
ENV CI_CLOUD_URL=${CI_CLOUD_URL}

RUN pnpm run build

RUN echo "TIPI_VERSION: ${TIPI_VERSION}"
RUN echo "LOCAL: ${LOCAL}"

RUN cd /app && pnpm run bundle 2>&1 | tail -100 || true

# ---- RUNNER ----
FROM runner_base AS runner

ENV NODE_ENV="production"

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save --omit=dev argon2 class-transformer @opentelemetry/api drizzle-orm pg ssh2 i18next-fs-backend

COPY --from=builder_base /deps/docker-binary /usr/local/bin/docker-compose
RUN chmod +x /usr/local/bin/docker-compose && \
    ls -lh /usr/local/bin/docker-compose && \
    mkdir -p /root/.docker/cli-plugins && \
    ln -s /usr/local/bin/docker-compose /root/.docker/cli-plugins/docker-compose
COPY --from=builder /app/package.json ./

    # Assets - copy built artifacts
    COPY --from=builder /app/packages/backend/dist ./
    COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/backend/src/modules/i18n/translations ./assets/translations
COPY --from=builder /app/packages/backend/src/swagger.json ./packages/backend/src/swagger.json
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

    # Ensure Node treats .js as ESM (esbuild outputs ESM format)
    RUN node -e "const p = require('./package.json'); p.type = 'module'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2))"

    CMD ["node", "./main.js"]
