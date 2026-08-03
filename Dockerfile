ARG NODE_VERSION="22"
ARG ALPINE_VERSION="3.21"
ARG BUILDPLATFORM
ARG TARGETPLATFORM
# NO default on TARGETARCH: a declared default OVERRIDES buildx's automatic
# per-platform value, so `=amd64` here made the linux/arm64 manifest slot build
# with TARGETARCH=amd64 — installing x86_64 docker-compose into arm64 images
# and failing the runner stage's arch sanity check. Plain `docker build` (no
# buildx) leaves it empty; the shell-level `${TARGETARCH:-amd64}` fallbacks
# below handle that.
ARG TARGETARCH
ARG DOCKER_PLATFORM=linux/amd64

# JS build stages run on BUILDPLATFORM for speed. Runtime stages MUST use
# TARGETPLATFORM so multi-arch CI (ubuntu-latest building linux/arm64) does not
# bake amd64 Node/native modules into the arm64 manifest slot.
FROM --platform=${BUILDPLATFORM:-${DOCKER_PLATFORM:-linux/amd64}} node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node_base

# ---- BUILDER BASE (build host arch) ----
FROM node_base AS builder_base

WORKDIR /deps

RUN set -eux; \
    apk add --no-cache curl python3 make g++ git || { \
      echo "Primary Alpine mirror failed, retrying with mirrors.edge.kernel.org"; \
      sed -i 's|https\?://dl-cdn.alpinelinux.org/alpine|https://mirrors.edge.kernel.org/alpine|g' /etc/apk/repositories; \
      apk add --no-cache curl python3 make g++ git; \
    }

# ---- RUNNER BASE (target arch — native Node, apk, and later native npm modules) ----
FROM --platform=${TARGETPLATFORM:-${DOCKER_PLATFORM:-linux/amd64}} node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runner_base

# tzdata is required, not cosmetic: compose bind-mounts the host's /etc/localtime into
# this container. Without a zoneinfo db, ICU cannot map that tzfile back to an IANA name
# and Intl.DateTimeFormat().resolvedOptions().timeZone yields undefined instead of a zone.
RUN set -eux; \
    apk add --no-cache curl openssl git docker-cli dmidecode pciutils setpriv tzdata || { \
      echo "Primary Alpine mirror failed, retrying with mirrors.edge.kernel.org"; \
      sed -i 's|https\?://dl-cdn.alpinelinux.org/alpine|https://mirrors.edge.kernel.org/alpine|g' /etc/apk/repositories; \
      apk add --no-cache curl openssl git docker-cli dmidecode pciutils setpriv tzdata; \
    }

# ---- BUILDER ----
FROM builder_base AS builder

ARG CI_HUB_VERSION
ARG CI_HUB_ENVIRONMENT
ARG LOCAL
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_RELEASE=""

ENV CI_HUB_VERSION=${CI_HUB_VERSION}
ENV CI_HUB_ENVIRONMENT=${CI_HUB_ENVIRONMENT}
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
ENV VITE_SENTRY_RELEASE=${VITE_SENTRY_RELEASE}

# Sentry source-map upload inputs (best-effort; see the RUN steps after the
# builds). The auth token is passed as a BuildKit secret, never as a build-arg,
# so it is not baked into image history. VITE_BUILD_SOURCEMAPS=1 makes the
# frontend build emit maps; they are uploaded and then stripped before shipping.
ARG SENTRY_ORG=""
ARG SENTRY_BACKEND_PROJECT=""
ARG SENTRY_FRONTEND_PROJECT=""
ARG SENTRY_RELEASE=""
ARG VITE_BUILD_SOURCEMAPS=""
ENV VITE_BUILD_SOURCEMAPS=${VITE_BUILD_SOURCEMAPS}

WORKDIR /app

COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./package.json ./
COPY ./packages/backend/package.json ./packages/backend/package.json
COPY ./packages/frontend/package.json ./packages/frontend/package.json
COPY ./packages/common/package.json ./packages/common/package.json
COPY ./packages/desktop/package.json ./packages/desktop/package.json
COPY ./packages/openclaw-plugin/package.json ./packages/openclaw-plugin/package.json
COPY ./packages/frontend/public ./packages/frontend/public

RUN corepack enable && \
    package_manager="$(node -p "require('./package.json').packageManager")" && \
    attempt=1 && \
    max_attempts=5 && \
    until corepack prepare "$package_manager" --activate; do \
      if [ "$attempt" -ge "$max_attempts" ]; then \
        echo "corepack prepare failed after ${max_attempts} attempts for ${package_manager}" >&2; \
        exit 1; \
      fi; \
      echo "corepack prepare failed (attempt ${attempt}/${max_attempts}) for ${package_manager}; retrying..." >&2; \
      sleep $((attempt * 5)); \
      attempt=$((attempt + 1)); \
    done

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

RUN echo "CI_HUB_VERSION: ${CI_HUB_VERSION}"
RUN echo "LOCAL: ${LOCAL}"

RUN cd /app && pnpm run bundle 2>&1 | tail -100 || true

# Inject Sentry debug IDs into the backend bundle and upload its source maps so
# production backend stack traces are readable instead of minified/bundled.
# Best-effort: only uploads when SENTRY_AUTH_TOKEN (BuildKit secret) plus
# SENTRY_ORG and SENTRY_BACKEND_PROJECT are provided, and never fails the build.
# The .map files are ALWAYS stripped afterward (whether or not the upload ran) so
# source is never shipped in the image — the appliance image is distributed to
# end users. Sentry resolves frames via the injected debug IDs.
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -s /run/secrets/sentry_auth_token ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_BACKEND_PROJECT" ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
      npx --yes @sentry/cli@2 sourcemaps inject packages/backend/dist || echo "::warning::backend sourcemaps inject failed"; \
      npx --yes @sentry/cli@2 sourcemaps upload \
        --org "$SENTRY_ORG" --project "$SENTRY_BACKEND_PROJECT" \
        --release "$SENTRY_RELEASE" packages/backend/dist || echo "::warning::backend sourcemap upload failed"; \
    else \
      echo "Skipping backend sourcemap upload (token/org/project not provided)"; \
    fi; \
    find packages/backend/dist -name '*.map' -delete || true

# Inject debug IDs into the browser frontend bundle and upload its source maps so
# browser stack traces are readable. Same best-effort gating as the backend step.
# The .map files are always stripped from dist/client afterward so they are never
# served to browsers (Sentry resolves frames via the injected debug IDs).
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -s /run/secrets/sentry_auth_token ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_FRONTEND_PROJECT" ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
      ( npx --yes @sentry/cli@2 sourcemaps inject packages/frontend/dist/client \
        && npx --yes @sentry/cli@2 sourcemaps upload \
             --org "$SENTRY_ORG" --project "$SENTRY_FRONTEND_PROJECT" \
             --release "$VITE_SENTRY_RELEASE" packages/frontend/dist/client \
      ) || echo "::warning::frontend sourcemap upload failed (non-fatal)"; \
    fi; \
    find packages/frontend/dist/client -name '*.map' -delete || true

# ---- RUNNER (target arch) ----
FROM runner_base AS runner

ARG TARGETARCH
ARG TARGETPLATFORM
ARG DOCKER_COMPOSE_VERSION="v2.40.0"
ENV TARGETARCH=${TARGETARCH}

ENV NODE_ENV="production"
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

# Backend Sentry DSN/release baked into the runtime image so error reporting
# works on every deployment target — including the desktop appliance, which
# runs this prebuilt image and never injects SENTRY_DSN via a runtime env file.
# Runtime env_file/environment values still override these when present.
ARG SENTRY_DSN=""
ARG SENTRY_RELEASE=""
ENV SENTRY_DSN=${SENTRY_DSN}
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

WORKDIR /app

# Install native modules and docker-compose on the TARGET platform so the arm64
# image slot cannot contain amd64 Node/native deps (Rosetta/QEMU footgun).
# RUN --platform=$TARGETPLATFORM is required: on arm64 CI runners buildx builds the
# linux/amd64 manifest slot as linux/arm64->amd64; without this, RUN executes on
# the build host and process.arch stays arm64 while TARGETARCH is amd64.
RUN --platform=$TARGETPLATFORM \
    --mount=type=cache,target=/root/.npm \
    npm install --no-save --omit=dev argon2 class-transformer @nestjs/mapped-types @opentelemetry/api drizzle-orm pg ssh2 i18next-fs-backend

RUN --platform=$TARGETPLATFORM \
    set -eux; \
    echo "Installing docker-compose for ${TARGETARCH:-amd64}"; \
    if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -fL --retry 3 --retry-delay 5 -o /usr/local/bin/docker-compose \
        "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-aarch64"; \
    elif [ "${TARGETARCH}" = "amd64" ] || [ -z "${TARGETARCH}" ]; then \
      curl -fL --retry 3 --retry-delay 5 -o /usr/local/bin/docker-compose \
        "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64"; \
    else \
      echo "ERROR: Unsupported TARGETARCH: ${TARGETARCH}" && exit 1; \
    fi; \
    chmod +x /usr/local/bin/docker-compose; \
    /usr/local/bin/docker-compose version; \
    node -p "process.arch" | grep -E '^(arm64|x64)$'; \
    case "${TARGETARCH:-amd64}" in \
      arm64) node -p "process.arch" | grep -qx arm64 ;; \
      amd64|"") node -p "process.arch" | grep -qx x64 ;; \
      *) echo "ERROR: Unsupported TARGETARCH: ${TARGETARCH}" && exit 1 ;; \
    esac

COPY --from=builder /app/package.json ./

# Assets - copy built artifacts
COPY --from=builder /app/packages/backend/dist ./
COPY --from=builder /app/packages/backend/assets ./assets
COPY --from=builder /app/packages/backend/src/core/database/drizzle ./assets/migrations
COPY --from=builder /app/packages/common/i18n/translations ./assets/translations
COPY --from=builder /app/packages/backend/src/swagger.json ./packages/backend/src/swagger.json
COPY --from=builder /app/packages/frontend/dist/client ./assets/frontend

EXPOSE 3000

# Ensure Node treats .js as ESM (esbuild outputs ESM format)
RUN node -e "const p = require('./package.json'); p.type = 'module'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2))"

# Entrypoint starts as root, heals bind-mount ownership (notably /app/tunnel),
# then drops to CI_HUB_CONTAINER_UID:GID with the DOCKER_GID supplementary
# group. This replaces the compose `user:` directive so the tunnel token can
# always be written. See docker-entrypoint.sh.
COPY docker-entrypoint.sh /usr/local/bin/hub-entrypoint.sh
RUN chmod +x /usr/local/bin/hub-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/hub-entrypoint.sh"]

# Hub runs as host UID/GID. /data/cache and /data/.docker are host bind mounts (init-hub-data-dirs.ts).
CMD ["sh", "-c", "ln -sf /usr/local/bin/docker-compose /data/.docker/cli-plugins/docker-compose 2>/dev/null || true; rm -f /data/state/.env.resolved 2>/dev/null || true; exec node ./main.js"]
