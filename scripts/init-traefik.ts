/**
 * Initialize Traefik configuration. Copies config files and generates TLS certificates.
 *
 * Usage:
 *   bun run scripts/init-traefik.ts
 *
 * Environment variables:
 *   RUNTIPI_STATE_PATH - State directory path (default: .internal)
 */
import { mkdir, copyFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const INTERNAL_DIR = process.env.CI_HUB_STATE_PATH || process.env.STATE_PATH || '.internal';
const STATE_DIR = path.join(INTERNAL_DIR, 'state');
const TRAEFIK_DIR = path.join(STATE_DIR, 'traefik');

async function initTraefik() {
  console.log('Initializing Traefik configuration...');

  // Create directory structure
  const dirs = [path.join(TRAEFIK_DIR, 'config'), path.join(TRAEFIK_DIR, 'dynamic'), path.join(TRAEFIK_DIR, 'tls')];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      console.log(`Creating directory: ${dir}`);
      await mkdir(dir, { recursive: true });
    }
  }

  // Copy config files
  const assetsDir = path.join(process.cwd(), 'packages/backend/assets/traefik');

  // traefik.yml
  const traefikSrc = path.join(assetsDir, 'traefik.yml');
  const traefikDest = path.join(TRAEFIK_DIR, 'config', 'traefik.yml');

  if (existsSync(traefikSrc)) {
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
      const content = await Bun.file(traefikSrc).text();
      const finalContent = content.replace('{{ACME_EMAIL}}', 'admin@localhost');
      await writeFile(traefikDest, finalContent);
    }
  } else {
    console.warn(`Warning: Source traefik.yml not found at ${traefikSrc}`);
  }

  // dynamic.yml
  // Check if dynamic folder exists in assets
  if (existsSync(path.join(assetsDir, 'dynamic'))) {
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

initTraefik().catch((err) => {
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
