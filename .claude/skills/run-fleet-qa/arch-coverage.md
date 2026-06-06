# CI-Marketplace — ARM / x64 Container Coverage Audit

_Generated 2026-06-05 · 168 apps · resolved via hub.docker.com REST + registry v2 manifest API (zero Docker Hub pull-limit cost)._

**Why:** the current fleet nodes are all `x86_64`; an app with no `linux/arm64` build for its whole compose stack cannot install on an ARM CI-Hub appliance.

## Summary

| Verdict | Apps |
|---|---:|
| both | 132 |
| amd64-only | 15 |
| arm64-only | 0 |
| partial-arm | 8 |
| private | 11 |
| unknown | 2 |

## amd64-only (no arm64 build)

| App | amd64-only image(s) |
|---|---|
| `arkanum` | `ocram85/arkanum:latest` |
| `comfyui` | `docker.io/kyuz0/amd-strix-halo-comfyui:latest` |
| `deepseek-ocr-webui` | `neosun/deepseek-ocr:latest` |
| `freeter` | `freeter/freeter:1.0` |
| `hunyuan3d` | `docker.io/kechiro/hunyuan3d-2.1-cachedstart:latest` |
| `hunyuan3d-rocm` | `docker.io/kyuz0/amd-strix-halo-comfyui:latest` |
| `macos` | `dockurr/macos:latest` |
| `novel` | `keeb/novel:latest` |
| `opencode-web` | `ghcr.io/nimbleflux/opencode-docker:latest` |
| `paddle-ocr` | `paddlecloud/paddleocr:2.5-cpu-latest` |
| `rms-mail` | `maxramas/rms-mail-ui:latest-m`, `maxramas/rms-mail:latest-m` |
| `rolltop` | `ghcr.io/grahamsz/rolltop:latest` |
| `steam-headless` | `josh5/steam-headless:latest` |
| `tldraw` | `foxxmd/tldraw:latest` |
| `vitriol` | `kl3mta3/vitriol-docker:latest` |

## partial-arm (dependency image is amd64-only)

| App | blocker(s) |
|---|---|
| `adventurelog` | `postgis/postgis:16-3.5` |
| `documenso` | `mailhog/mailhog:v1.0.1` |
| `keila` | `pentacent/keila:latest` |
| `mattermost` | `mattermost/mattermost-team-edition:latest` |
| `medusa` | `jaspreet237/medusajsv2:latest` |
| `papercups` | `papercups/papercups:latest` |
| `rocketchat` | `rocket.chat:latest` |
| `taiga` | `taigaio/taiga-back:latest`, `taigaio/taiga-events:latest`, `taigaio/taiga-front:latest` |

## Full per-app matrix

| App | Verdict | Images (arches) |
|---|---|---|
| `activepieces` | both | `activepieces/activepieces:latest` [amd64,arm64]; `postgres:14` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x] |
| `adguardhome-sync` | both | `ghcr.io/bakito/adguardhome-sync:latest` [amd64,arm/v6,arm/v7,arm64,ppc64le] |
| `adventurelog` | partial-arm | `ghcr.io/seanmorley15/adventurelog-backend:latest` [amd64,arm64]; `ghcr.io/seanmorley15/adventurelog-frontend:latest` [amd64,arm64]; `postgis/postgis:16-3.5` [amd64] |
| `affine` | both | `ghcr.io/toeverything/affine:0.26.7` [amd64,arm/v7,arm64]; `postgres:16` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `anything-llm` | both | `mintplexlabs/anythingllm:latest` [amd64,arm64] |
| `appflowy` | both | `appflowyinc/appflowy_cloud:latest` [amd64,arm64]; `appflowyinc/appflowy_web:latest` [amd64,arm64]; `appflowyinc/gotrue:latest` [amd64,arm64]; `minio/minio:RELEASE.2025-09-07T16-13-09Z` [amd64,arm64,ppc64le]; `nginx:alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `pgvector/pgvector:pg16` [amd64,arm64]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `appwrite` | both | `appwrite/appwrite:latest` [amd64,arm64]; `mariadb:10.11` [amd64,arm64,ppc64le,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `archivebox` | both | `archivebox/archivebox:latest` [amd64,arm64] |
| `arkanum` | amd64-only | `ocram85/arkanum:latest` [amd64] |
| `baserow` | both | `baserow/baserow:latest` [amd64,arm64] |
| `bitcoind` | both | `lncm/bitcoind:v28.0` [amd64,arm/v7,arm64] |
| `blender-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `brewers-almanack-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `bytebase` | both | `bytebase/bytebase:latest` [amd64,arm64] |
| `chess-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `ci-earth` | private | `ghcr.io/companionintelligence/ci-earth:latest` [private/auth] |
| `ci-hermes` | both | `ghcr.io/companionintelligence/ci-hermes:v2026.6.6` [amd64,arm64] |
| `ci-import-tools` | private | `ghcr.io/companionintelligence/ci-import-tools:latest` [private/auth] |
| `ci-just-in-case` | private | `ghcr.io/companionintelligence/ci-just-in-case:latest` [private/auth] |
| `ci-local-bench` | private | `ghcr.io/companionintelligence/ci-local-bench:latest` [private/auth] |
| `ci-openclaw` | both | `ghcr.io/companionintelligence/ci-openclaw:2026.6.5` [amd64,arm64] |
| `ci-photo-time-machine` | private | `ghcr.io/companionintelligence/ci-photo-time-machine:latest` [private/auth] |
| `ci-spatial-companion-webxr` | private | `ghcr.io/companionintelligence/ci-spatial-companion-webxr:latest` [private/auth] |
| `ci-spellbook` | private | `ghcr.io/companionintelligence/ci-spellbook:latest` [private/auth] |
| `ci-static-containter-builder` | private | `ghcr.io/companionintelligence/ci-static-containter-builder:latest` [private/auth] |
| `ci-tools-cache-mounts` | private | `ghcr.io/companionintelligence/ci-tools-cache-mounts:latest` [private/auth] |
| `ci-webxr-time-machine` | private | `ghcr.io/companionintelligence/ci-webxr-time-machine:latest` [private/auth] |
| `cloudreve` | both | `cloudreve/cloudreve:latest` [amd64,arm64]; `postgres:17` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x] |
| `code-server` | both | `lscr.io/linuxserver/code-server:latest` [amd64,arm64] |
| `colanode` | both | `ghcr.io/colanode/server:latest` [amd64,arm64]; `ghcr.io/colanode/web:latest` [amd64,arm64]; `nginx:1.27-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `pgvector/pgvector:pg17` [amd64,arm64]; `valkey/valkey:8.1` [amd64,arm/v7,arm64,ppc64le] |
| `collabora-online` | both | `collabora/code:latest` [amd64,arm64,ppc64le] |
| `comfyui` | amd64-only | `docker.io/kyuz0/amd-strix-halo-comfyui:latest` [amd64] |
| `coolify` | both | `alpine:3.23.4` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `ghcr.io/coollabsio/coolify-realtime:latest` [amd64,arm64]; `ghcr.io/coollabsio/coolify:latest` [amd64,arm64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `cypht` | both | `cypht/cypht:latest` [386,amd64,arm/v6,arm/v7,arm64] |
| `deepseek-ocr-webui` | amd64-only | `neosun/deepseek-ocr:latest` [amd64] |
| `docmost` | both | `docmost/docmost:latest` [amd64,arm64]; `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7.2-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `documenso` | partial-arm | `documenso/documenso:latest` [amd64,arm64]; `mailhog/mailhog:v1.0.1` [amd64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `docuseal` | both | `docuseal/docuseal:latest` [amd64,arm64]; `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `doordash-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `dropgate` | both | `willtda/dropgate-server:latest` [amd64,arm64] |
| `element` | both | `vectorim/element-web:latest` [amd64,arm64] |
| `emulatorjs` | unknown | `lscr.io/linuxserver/emulatorjs:latest` [unknown] |
| `espocrm` | both | `espocrm/espocrm:latest` [386,amd64,arm/v5,arm/v7,arm64]; `mysql:8` [amd64,arm64] |
| `excalidraw` | both | `excalidraw/excalidraw:latest` [amd64,arm/v7,arm64] |
| `excalidraw-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `fetch-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `file-browser` | both | `filebrowser/filebrowser:latest` [amd64,arm/v7,arm64] |
| `filesystem-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `flowise` | both | `docker.io/flowiseai/flowise:latest` [amd64,arm64] |
| `forgejo` | both | `codeberg.org/forgejo/forgejo:11.0.14-rootless` [amd64,arm/v6,arm64]; `postgres:14` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `freeter` | amd64-only | `freeter/freeter:1.0` [amd64] |
| `frigate` | both | `ghcr.io/blakeblackshear/frigate:0.16.4` [amd64,arm64] |
| `galette` | both | `galette/galette:latest` [amd64,arm/v7,arm64]; `mariadb:11` [amd64,arm64,ppc64le,s390x] |
| `ghost` | both | `ghost:latest` [amd64,arm/v7,arm64,s390x] |
| `git-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `gitea` | both | `docker.gitea.com/gitea:latest` [amd64,arm64,riscv64]; `postgres:14` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `github-mcp` | both | `ghcr.io/github/github-mcp-server:latest` [amd64,arm64] |
| `gitlab` | both | `gitlab/gitlab-ce:latest` [amd64,arm64] |
| `graylog` | both | `graylog/graylog:6.3.13` [amd64,arm64]; `mongo:6.0` [amd64,arm64]; `opensearchproject/opensearch:2.11.1` [amd64,arm64] |
| `grocy` | both | `linuxserver/grocy:latest` [amd64,arm64] |
| `hermes-agent` | both | `nousresearch/hermes-agent:latest` [amd64,arm64] |
| `home-assistant` | both | `ghcr.io/home-assistant-libs/python-matter-server:8.1.0` [amd64,arm64]; `ghcr.io/home-assistant/home-assistant:latest` [amd64,arm64] |
| `hoppscotch` | both | `hoppscotch/hoppscotch:latest` [amd64,arm64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `hunyuan3d` | amd64-only | `docker.io/kechiro/hunyuan3d-2.1-cachedstart:latest` [amd64] |
| `hunyuan3d-rocm` | amd64-only | `docker.io/kyuz0/amd-strix-halo-comfyui:latest` [amd64] |
| `immich` | both | `ghcr.io/immich-app/immich-machine-learning:release` [amd64,arm64]; `ghcr.io/immich-app/immich-server:release` [amd64,arm64]; `redis:6.2-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `tensorchord/pgvecto-rs:pg14-v0.2.1` [amd64,arm64] |
| `inkscape` | both | `kasmweb/inkscape:1.19.0` [amd64,arm64] |
| `jellyfin` | both | `jellyfin/jellyfin:latest` [amd64,arm64] |
| `jitsi` | both | `jitsi/jicofo:stable-9823` [amd64,arm64]; `jitsi/jvb:stable-9823` [amd64,arm64]; `jitsi/prosody:stable-9823` [amd64,arm64]; `jitsi/web:stable-10978` [amd64,arm64] |
| `joplin` | both | `joplin/server:latest` [amd64,arm64]; `postgres:16` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `keila` | partial-arm | `pentacent/keila:latest` [amd64]; `postgres:14-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `kiwix` | both | `ghcr.io/kiwix/kiwix-serve:latest` [386,amd64,arm/v6,arm/v7,arm64] |
| `langflow` | both | `langflowai/langflow:latest` [amd64,arm64] |
| `leantime` | both | `leantime/leantime:latest` [amd64,arm/v8,arm64]; `mysql:8.4` [amd64,arm64] |
| `lego-oracle-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `librechat` | both | `getmeili/meilisearch:v1.35.1` [amd64,arm64]; `ghcr.io/danny-avila/librechat:latest` [amd64,arm64]; `mongo:8.0` [amd64,arm64] |
| `libreoffice` | both | `linuxserver/libreoffice:latest` [amd64,arm64] |
| `librespeed` | both | `ghcr.io/librespeed/speedtest:latest` [amd64,arm/v7,arm64] |
| `listmonk` | both | `docker.io/listmonk/listmonk:latest` [amd64,arm/v6,arm/v7,arm64]; `postgres:14-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `lobe-chat` | both | `lobehub/lobe-chat:latest` [amd64,arm64] |
| `logseq` | both | `ghcr.io/logseq/logseq-webapp:latest` [amd64,arm64] |
| `macos` | amd64-only | `dockurr/macos:latest` [amd64] |
| `mailu` | both | `ghcr.io/mailu/admin:latest` [amd64,arm/v7,arm64]; `ghcr.io/mailu/dovecot:latest` [amd64,arm/v7,arm64]; `ghcr.io/mailu/nginx:latest` [amd64,arm/v7,arm64]; `ghcr.io/mailu/postfix:latest` [amd64,arm/v7,arm64]; `ghcr.io/mailu/rspamd:latest` [amd64,arm/v7,arm64]; `redis:alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `mastodon` | both | `ghcr.io/mastodon/mastodon:latest` [amd64,arm64]; `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `matomo` | both | `alpine:3.23.4` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `mariadb:11` [amd64,arm64,ppc64le,s390x]; `matomo:latest` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `mattermost` | partial-arm | `mattermost/mattermost-team-edition:latest` [amd64]; `postgres:14-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `medusa` | partial-arm | `jaspreet237/medusajsv2:latest` [amd64]; `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x] |
| `memory-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `memos` | both | `neosmemo/memos:0.29.1` [amd64,arm/v7,arm64] |
| `miro-mcp` | both | `alpine:3.20` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `mixpost` | both | `inovector/mixpost:latest` [amd64,arm64]; `mysql:8.0` [amd64,arm64]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `mobilerun` | both | `ghcr.io/droidrun/mobilerun:latest` [amd64,arm64] |
| `music-assistant` | both | `ghcr.io/music-assistant/server:latest` [amd64,arm64] |
| `n8n` | both | `ghcr.io/n8n-io/n8n:latest` [amd64,arm64]; `postgres:16` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `n8n-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `netdata` | both | `netdata/netdata:latest` [amd64,arm/v7,arm64] |
| `nextcloud` | both | `nextcloud:latest` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `nocodb` | both | `nocodb/nocodb:latest` [amd64,arm/v7,arm64]; `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `nostr-relay` | both | `getumbrel/nostr-rs-relay:0.8.1` [amd64,arm64] |
| `notediscovery` | both | `ghcr.io/gamosoft/notediscovery:latest` [amd64,arm64] |
| `notion-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `novel` | amd64-only | `keeb/novel:latest` [amd64] |
| `obsidian-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `odoo` | both | `odoo:latest` [amd64,arm64,ppc64le]; `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `onlyoffice` | both | `onlyoffice/documentserver:latest` [amd64,arm64] |
| `onlyoffice-docspace-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `open-webui` | both | `ghcr.io/open-webui/open-webui:latest` [amd64,arm64] |
| `openclaw` | both | `ghcr.io/getumbrel/openclaw-umbrel:2026.6.1` [amd64,arm64] |
| `opencode-web` | amd64-only | `ghcr.io/nimbleflux/opencode-docker:latest` [amd64] |
| `openproject` | both | `memcached:1.6-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `openproject/openproject:16.6.3-slim` [amd64,arm64]; `postgres:17-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `paddle-ocr` | amd64-only | `paddlecloud/paddleocr:2.5-cpu-latest` [amd64] |
| `pairdrop` | both | `ghcr.io/schlagmichdoch/pairdrop:latest` [amd64,arm64] |
| `papercups` | partial-arm | `papercups/papercups:latest` [amd64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `passbolt` | both | `mariadb:10.5` [amd64,arm64,ppc64le,s390x]; `passbolt/passbolt:latest` [amd64,arm/v5,arm/v7,arm64] |
| `penpot` | both | `penpotapp/backend:latest` [amd64,arm64]; `penpotapp/exporter:latest` [amd64,arm64]; `penpotapp/frontend:latest` [amd64,arm64]; `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x] |
| `photoprism` | both | `mariadb:11` [amd64,arm64,ppc64le,s390x]; `photoprism/photoprism:latest` [amd64,arm64] |
| `pi-hole` | both | `pihole/pihole:latest` [386,amd64,arm/v6,arm/v7,arm64,riscv64] |
| `plane` | both | `makeplane/plane-backend:latest` [amd64,arm64]; `makeplane/plane-frontend:latest` [amd64,arm64]; `minio/minio:RELEASE.2025-09-07T16-13-09Z` [amd64,arm64,ppc64le]; `nginx:alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `rabbitmq:3-management-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `plausible` | both | `clickhouse/clickhouse-server:24.3.3.102-alpine` [amd64,arm64]; `ghcr.io/plausible/community-edition:latest` [amd64,arm64]; `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `playwright-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `plex` | both | `lscr.io/linuxserver/plex:latest` [amd64,arm64] |
| `plugnmeet` | both | `mynaparrot/plugnmeet-server:latest` [amd64,arm64] |
| `pocketbase` | both | `ghcr.io/muchobien/pocketbase:latest` [amd64,arm/v7,arm64] |
| `postgres-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `postiz` | both | `elasticsearch:7.17.27` [amd64,arm64]; `ghcr.io/gitroomhq/postiz-app:latest` [amd64,arm64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `postgres:16` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `temporalio/auto-setup:1.28.1` [amd64,arm64] |
| `prestashop` | both | `mysql:8` [amd64,arm64]; `prestashop/prestashop:latest` [amd64,arm/v7,arm64] |
| `prometheus` | both | `prom/prometheus:latest` [amd64,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `qbittorrent` | both | `lscr.io/linuxserver/qbittorrent:latest` [amd64,arm64] |
| `quarkdown` | both | `eclipse-temurin:17-jdk-jammy` [amd64,arm/v7,arm64,ppc64le,s390x] |
| `readeck` | both | `codeberg.org/readeck/readeck:0.22.3` [amd64,arm64] |
| `rms-mail` | amd64-only | `maxramas/rms-mail-ui:latest-m` [amd64]; `maxramas/rms-mail:latest-m` [amd64] |
| `rocketchat` | partial-arm | `mongo:6.0` [amd64,arm64]; `rocket.chat:latest` [amd64] |
| `rolltop` | amd64-only | `ghcr.io/grahamsz/rolltop:latest` [amd64] |
| `safeos` | private | `ghcr.io/framersai/safeos-api:0.1.0` [private/auth]; `ollama/ollama:latest` [amd64,arm64] |
| `seafile` | both | `docker.io/seafileltd/seafile-mc:latest` [amd64,arm64]; `mariadb:10.11` [amd64,arm64,ppc64le,s390x]; `memcached:1.6.29` [386,amd64,arm/v5,arm64,mips64le,ppc64le,s390x] |
| `searxng` | both | `searxng/searxng:latest` [amd64,arm/v7,arm64] |
| `securo` | both | `docker.io/library/redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `docker.io/pgvector/pgvector:pg16` [amd64,arm64]; `ghcr.io/securo-finance/securo-backend:latest` [amd64,arm64]; `ghcr.io/securo-finance/securo-frontend:latest` [amd64,arm64] |
| `sillytavern` | both | `ghcr.io/sillytavern/sillytavern:latest` [amd64,arm64] |
| `smartest-tv-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `snort` | both | `voidic/snort:latest` [amd64,arm64] |
| `solidtime` | both | `gotenberg/gotenberg:8` [386,amd64,arm/v7,arm64,ppc64le]; `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `solidtime/solidtime:latest` [amd64,arm64] |
| `sqlite-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `stalwart-mail` | both | `ghcr.io/stalwartlabs/stalwart:latest` [amd64,arm/v6,arm/v7,arm64] |
| `standard-notes` | both | `mysql:8.0` [amd64,arm64]; `redis:7-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `standardnotes/server:latest` [amd64,arm64] |
| `steam-headless` | amd64-only | `josh5/steam-headless:latest` [amd64] |
| `steam-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `stirling-pdf` | both | `stirlingtools/stirling-pdf:latest` [amd64,arm64] |
| `suroi` | unknown | `hasangergames/suroi:latest` [http404] |
| `taiga` | partial-arm | `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `rabbitmq:3.8-management-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,s390x]; `taigaio/taiga-back:latest` [amd64]; `taigaio/taiga-events:latest` [amd64]; `taigaio/taiga-front:latest` [amd64] |
| `tandoor` | both | `postgres:16-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x]; `vabene1111/recipes:latest` [amd64,arm64] |
| `teable` | both | `ghcr.io/teableio/teable:latest` [amd64,arm64]; `postgres:15.4` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x]; `redis:7.2.4` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x] |
| `tldraw` | amd64-only | `foxxmd/tldraw:latest` [amd64] |
| `twenty` | both | `postgres:15` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x]; `redis:7` [386,amd64,arm/v5,arm/v7,arm64,mips64le,ppc64le,s390x]; `twentycrm/twenty:latest` [amd64,arm64] |
| `umami` | both | `ghcr.io/umami-software/umami:latest` [amd64,arm64]; `postgres:15-alpine` [386,amd64,arm/v6,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `unity-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
| `unity-mcp-ivanmurzak` | both | `ivanmurzakdev/unity-mcp-server:latest` [amd64,arm64] |
| `unreal-engine-mcp` | both | `node:22-alpine` [amd64,arm/v6,arm/v7,arm64,s390x] |
| `uptime-kuma` | both | `louislam/uptime-kuma:latest` [amd64,arm/v7,arm64] |
| `vane` | both | `itzcrazykns1337/vane:latest` [amd64,arm64] |
| `vaultwarden` | both | `ghcr.io/dani-garcia/vaultwarden:latest` [amd64,arm/v6,arm/v7,arm64] |
| `vitriol` | amd64-only | `kl3mta3/vitriol-docker:latest` [amd64] |
| `vui` | both | `ghcr.io/suwayomi/suwayomi-vui:latest` [386,amd64,arm/v6,arm/v7,arm64] |
| `wallos` | both | `bellamy/wallos:latest` [amd64,arm/v7,arm64] |
| `windows` | both | `dockurr/windows:latest` [amd64,arm64] |
| `windows-arm` | both | `dockurr/windows-arm:latest` [amd64,arm64] |
| `woodpecker-ci` | both | `gitea/gitea:latest` [amd64,arm64,riscv64]; `woodpeckerci/woodpecker-agent:latest` [amd64,arm/v8,arm64,ppc64le,riscv64,s390x]; `woodpeckerci/woodpecker-server:latest` [amd64,arm/v8,arm64,ppc64le,riscv64,s390x] |
| `wordpress` | both | `mariadb:11.1.3` [amd64,arm64,ppc64le,s390x]; `wordpress:latest` [386,amd64,arm/v5,arm/v7,arm64,ppc64le,riscv64,s390x] |
| `youtube-transcript-mcp` | both | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` [amd64,arm64] |
