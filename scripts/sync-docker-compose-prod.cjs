#!/usr/bin/env node
/**
 * Sync docker-compose.prod.yml into the Tauri desktop bundle.
 *
 * The root compose is for source checkouts (build from Dockerfile). The desktop
 * bundle must pull a prebuilt image via CI_HUB_IMAGE — the data dir has no
 * Dockerfile and cannot build locally.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'docker-compose.prod.yml');
const target = path.join(repoRoot, 'packages/desktop/src-tauri/resources/docker-compose.prod.yml');

const rootCompose = fs.readFileSync(source, 'utf-8');

const buildBlockRe = /(\n {2}ci-os-hub:[\s\S]*?\n)( {4}build:[\s\S]*?\n)( {4}depends_on:)/;

// Fallback repo must be the public GHCR package (`ci-hub`), matching HUB_STACK_IMAGE_REPO
// in the desktop's hub_env.rs and the backend's common/constants.ts. The desktop normally
// writes an explicit CI_HUB_IMAGE into .env, so this default only applies when that is
// missing — which is exactly when it must still be anonymously pullable. Note the service
// key below stays `ci-os-hub`: that is the container name, not the image repo.
const desktopHubService = `    image: \${CI_HUB_IMAGE:-ghcr.io/companionintelligence/ci-hub:latest}
    pull_policy: if_not_present
`;

const patched = rootCompose.replace(buildBlockRe, `$1${desktopHubService}$3`);
if (patched === rootCompose) {
  console.error('sync-docker-compose-prod: expected ci-os-hub build block in root compose; sync aborted');
  process.exit(1);
}

fs.writeFileSync(target, patched);
console.log(`Synced ${path.relative(repoRoot, source)} → ${path.relative(repoRoot, target)} (desktop image pull)`);
