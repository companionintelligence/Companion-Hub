/**
 * Initialize Traefik configuration. Copies config files and generates TLS certificates.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-traefik.ts
 *
 * Writes under `${ROOT_FOLDER_HOST}/state/traefik` — the path the compose file bind-mounts — resolved
 * the same way init-hub-data-dirs resolves it: the env file's ROOT_FOLDER_HOST, then the process env,
 * then CI_HUB_STATE_PATH / STATE_PATH, then `.internal` under the cwd.
 */
import { mkdir, copyFile, writeFile, chmod, rm, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isDirectScriptRun } from './lib/is-direct-run';
import { resolveRootFolderHostForRuntime } from './lib/paths';
import { BUNDLED_TRAEFIK_DYNAMIC_YML, BUNDLED_TRAEFIK_YML } from './lib/bundled-hub-assets.generated';
import { findTraefikAssets } from './lib/seed-appliance';

/**
 * Resolved at call time, not import time. `cihub up` imports this module at startup and only later
 * runs it under `runScript` with ENV_FILE / ROOT_FOLDER_HOST set for the target install; a
 * module-level constant would have read the env before those overrides existed. On an appliance
 * (`~/.local/share/companion-hub`) that difference is the whole traefik directory.
 */
function resolveTraefikDir(): string {
  return path.join(resolveRootFolderHostForRuntime(), 'state', 'traefik');
}

/**
 * @param options.assetsDir where to copy traefik.yml/dynamic.yml from; `null` means "nothing on disk"
 *   (the bundled copies are written), `undefined` means search the usual places. Tests only.
 */
export async function initTraefik(options: { assetsDir?: string | null } = {}) {
  console.log('Initializing Traefik configuration...');
  const TRAEFIK_DIR = resolveTraefikDir();

  // Create directory structure
  const dirs = [path.join(TRAEFIK_DIR, 'config'), path.join(TRAEFIK_DIR, 'dynamic'), path.join(TRAEFIK_DIR, 'tls')];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      console.log(`Creating directory: ${dir}`);
      await mkdir(dir, { recursive: true });
    }
  }

  // Copy config files. `process.cwd()` only resolves this inside a CI-Hub checkout — a
  // packaged/standalone `cihub` (no checkout, no desktop install) needs the same
  // execPath-relative search `findBundledCompose` already does for docker-compose.prod.yml.
  const assetsDir = options.assetsDir === undefined ? findTraefikAssets() : (options.assetsDir ?? undefined);

  // traefik.yml
  const traefikSrc = assetsDir ? path.join(assetsDir, 'traefik.yml') : undefined;
  const traefikDest = path.join(TRAEFIK_DIR, 'config', 'traefik.yml');

  if (traefikSrc && existsSync(traefikSrc)) {
    let shouldCopy = true;
    if (existsSync(traefikDest)) {
      const destStats = await stat(traefikDest);
      if (destStats.isDirectory()) {
        console.log(`Removing directory at destination: ${traefikDest}`);
        await rm(traefikDest, { recursive: true, force: true });
      } else {
        const srcStats = await stat(traefikSrc);
        if (destStats.mtimeMs >= srcStats.mtimeMs) {
          shouldCopy = false;
          console.log('traefik.yml already up to date');
        }
      }
    }
    if (shouldCopy) {
      console.log(`Copying traefik.yml to ${traefikDest}`);
      const content = await readFile(traefikSrc, 'utf8');
      const finalContent = content.replace('{{ACME_EMAIL}}', 'admin@localhost');
      await writeFile(traefikDest, finalContent);
    }
  } else if (traefikSrc) {
    console.warn(`Warning: Source traefik.yml not found at ${traefikSrc}`);
  } else {
    // Nothing on disk to copy from: a standalone binary on a headless box. The files are baked into
    // the CLI at build time (scripts/generate-bundled-hub-assets.ts); write them when they are
    // absent, and leave an operator's edited copy alone.
    if (!existsSync(traefikDest)) {
      console.log(`Writing bundled traefik.yml to ${traefikDest}`);
      await writeFile(traefikDest, BUNDLED_TRAEFIK_YML.replace('{{ACME_EMAIL}}', 'admin@localhost'));
    }
    const dynamicDest = path.join(TRAEFIK_DIR, 'dynamic', 'dynamic.yml');
    if (!existsSync(dynamicDest)) {
      console.log(`Writing bundled dynamic.yml to ${dynamicDest}`);
      await writeFile(dynamicDest, BUNDLED_TRAEFIK_DYNAMIC_YML);
    }
  }

  // dynamic.yml
  // Check if dynamic folder exists in assets
  if (assetsDir && existsSync(path.join(assetsDir, 'dynamic'))) {
    // We might want to copy specific files or just one common dynamic.yml
    // Based on previous code, it seems dynamic.yml is expected
    const dynamicSrc = path.join(assetsDir, 'dynamic', 'dynamic.yml'); // Assumption based on typical setup
    const dynamicDest = path.join(TRAEFIK_DIR, 'dynamic', 'dynamic.yml');

    if (existsSync(dynamicSrc)) {
      let shouldCopyDynamic = true;
      if (existsSync(dynamicDest)) {
        const destStats = await stat(dynamicDest);
        if (destStats.isDirectory()) {
          console.log(`Removing directory at destination: ${dynamicDest}`);
          await rm(dynamicDest, { recursive: true, force: true });
        } else {
          const srcStats = await stat(dynamicSrc);
          if (destStats.mtimeMs >= srcStats.mtimeMs) {
            shouldCopyDynamic = false;
            console.log('dynamic.yml already up to date');
          }
        }
      }
      if (shouldCopyDynamic) {
        console.log(`Copying dynamic.yml to ${dynamicDest}`);
        await copyFile(dynamicSrc, dynamicDest);
      }
    }
  }

  // acme.json (using acme_storage.json to avoid Docker mount conflicts)
  const acmeDest = path.join(TRAEFIK_DIR, 'acme_storage.json');
  if (existsSync(acmeDest)) {
    // Check if it is a directory
    const stats = await stat(acmeDest);
    if (stats.isDirectory()) {
      console.log(`Removing directory at destination: ${acmeDest}`);
      await rm(acmeDest, { recursive: true, force: true });
      await writeFile(acmeDest, '{}');
      await chmod(acmeDest, 0o600);
    }
  } else {
    console.log(`Creating empty acme_storage.json at ${acmeDest}`);
    await writeFile(acmeDest, '{}');
    await chmod(acmeDest, 0o600);
  }

  console.log('Traefik initialization complete.');
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  initTraefik().catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.error('Failed to initialize Traefik: Permission denied');
      console.error('');
      console.error('The .internal directory appears to be owned by root or another user.');
      console.error('This commonly happens when Docker containers create directories.');
      console.error('');
      console.error('To fix this, run the following command in your terminal:');
      console.error(`  sudo chown -R $USER:$USER ${process.env.CI_HUB_STATE_PATH || '.internal'}`);
      console.error('');
      console.error('Original error:', err.message);
    } else {
      console.error('Failed to initialize Traefik:', err);
    }
    process.exit(1);
  });
}
