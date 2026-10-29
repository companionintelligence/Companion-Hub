import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const commonRoot = process.env.CI_COMMON_ROOT?.trim();
const pinnedRevision = 'f49f3822118f75dc9c037703d8cc9fdf5252e2f2';
const checkOnly = process.argv.includes('--check');

if (!commonRoot) {
  throw new Error('Set CI_COMMON_ROOT to a CI-Common checkout before syncing the logo mirrors.');
}

const revision = execFileSync('git', ['-C', commonRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== pinnedRevision) {
  throw new Error(`Expected CI-Common ${pinnedRevision}, found ${revision}. Update the pinned revision before syncing.`);
}

const manifest = JSON.parse(await readFile(resolve(commonRoot, 'assets/brand.config.json'), 'utf8'));
const assets = [
  { id: 'logo.lockup-on-light', destination: 'packages/frontend/public/brand/logo.lockup-on-light.svg' },
  { id: 'logo.lockup', destination: 'packages/frontend/public/brand/logo.lockup.svg' },
  { id: 'logo.mark-tight', destination: 'packages/frontend/public/logo.svg' },
];

for (const { id, destination } of assets) {
  const entry = manifest.logo.find((asset) => asset.id === id);
  if (!entry?.sha256) throw new Error(`CI-Common manifest is missing a checked-in hash for ${id}.`);

  const source = await readFile(resolve(commonRoot, 'assets', entry.path));
  const actualHash = createHash('sha256').update(source).digest('hex');
  if (actualHash !== entry.sha256) throw new Error(`CI-Common asset ${id} does not match its manifest hash.`);

  const target = resolve(repoRoot, destination);
  if (checkOnly) {
    const current = await readFile(target).catch(() => null);
    if (!current?.equals(source)) throw new Error(`${destination} is stale; run pnpm sync:brand-logo to update it.`);
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

if (!checkOnly) console.log(`Synced ${assets.length} generated logo mirrors from CI-Common ${pinnedRevision}.`);
