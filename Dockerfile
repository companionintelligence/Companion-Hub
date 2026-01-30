ARG NODE_VERSION="22"
ARG ALPINE_VERSION="3.21"

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS base

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

RUN apk add --no-cache curl python3 make g++ git

# ---- BUILDER ----
FROM base AS builder

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/common/package.json ./packages/common/package.json

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages ./packages
COPY packages/frontend/public ./packages/frontend/public

# Build
ARG TIPI_VERSION
ENV TIPI_VERSION=${TIPI_VERSION}
# We keep NODE_ENV default (development) for build to have devDependencies

RUN pnpm run build
RUN pnpm run bundle

# ---- RUNNER ----
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runner

ENV NODE_ENV="production"

WORKDIR /app

RUN apk add --no-cache curl openssl git docker-cli python3 make g++

# Install dependencies that are external in the bundle
RUN npm install -g pnpm && \
    pnpm add argon2 class-transformer

# Install docker-compose
ARG TARGETARCH
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -L -o /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-aarch64"; \
    elif [ "${TARGETARCH}" = "amd64" ] || [ -z "${TARGETARCH}" ]; then \
      curl -L -o /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64"; \
    fi && \
    chmod +x /usr/local/bin/docker-compose

COPY --from=builder /app/package.json ./

# Copy built artifacts
COPY --from=builder /app/packages/backend/dist ./
COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/backend/src/modules/i18n/translations ./assets/translations
COPY --from=builder /app/packages/backend/src/swagger.json ./packages/backend/src/swagger.json
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

RUN mv main.js main.mjs

CMD ["node", "./main.mjs"]
