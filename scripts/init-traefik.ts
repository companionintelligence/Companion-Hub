import { mkdir, copyFile, writeFile, chmod, rm, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const INTERNAL_DIR = process.env.RUNTIPI_STATE_PATH || '.internal';
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
    // Check if dest is a directory (Docker mess up)
    if (existsSync(traefikDest)) {
      const stats = await stat(traefikDest);
      if (stats.isDirectory()) {
        console.log(`Removing directory at destination: ${traefikDest}`);
        await rm(traefikDest, { recursive: true, force: true });
      }
    }

    console.log(`Copying traefik.yml to ${traefikDest}`);
    // Replace placeholder with default if necessary
    const content = await readFile(traefikSrc, 'utf-8');
    const finalContent = content.replace('{{ACME_EMAIL}}', 'admin@localhost');
    await writeFile(traefikDest, finalContent);
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
      if (existsSync(dynamicDest)) {
        const stats = await stat(dynamicDest);
        if (stats.isDirectory()) {
          console.log(`Removing directory at destination: ${dynamicDest}`);
          await rm(dynamicDest, { recursive: true, force: true });
        }
      }
      console.log(`Copying dynamic.yml to ${dynamicDest}`);
      await copyFile(dynamicSrc, dynamicDest);
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
  console.error('Failed to initialize Traefik:', err);
  process.exit(1);
});
