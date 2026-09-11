#!/usr/bin/env node
// sync-brand.mjs — the brand files under public/ are COPIES of @companionintelligence/assets
// (CI-Common `assets/`, the org's one logo origin). A static export needs them on disk,
// so they are committed; this script is what makes them a mirror rather than a second
// hand-maintained original.
//
//   node scripts/sync-brand.mjs            # rewrite public/* from the installed package
//   node scripts/sync-brand.mjs --check    # exit 1 if any copy differs from the origin
//   node scripts/sync-brand.mjs --from ../CI-Common/assets   # use a checkout instead of node_modules
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // packages/frontend
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fromIdx = argv.indexOf('--from');
const ORIGIN = fromIdx !== -1
  ? resolve(argv[fromIdx + 1])
  : dirname(createRequire(import.meta.url).resolve('@companionintelligence/assets/package.json'));

/** public path → origin path (relative to the assets package). Ids in brand.config.json. */
const MAP = {
  'public/logo.svg': 'logos/mark-tight.svg',                        // logo.mark-tight
  'public/2024_CI__LogoMark_Color_med.svg': 'logos/mark.svg',         // logo.mark
  'public/2024_CI__Logo_Banner_Color_small.svg': 'logos/lockup.svg',  // logo.lockup
  'public/icons/favicon.svg': 'logos/mark-tight.svg',
  'public/icons/favicon.ico': 'icons/png/favicon.ico',
  'public/icons/favicon-96x96.png': 'icons/png/favicon-96.png',
  'public/icons/apple-touch-icon.png': 'icons/png/apple-touch-icon-180.png',
  'public/icons/web-app-manifest-192x192.png': 'icons/png/icon-192.png',
  'public/icons/web-app-manifest-512x512.png': 'icons/png/icon-512.png',
};

const sha = (b) => createHash('sha256').update(b).digest('hex');
const drift = []; let n = 0;
for (const [dest, src] of Object.entries(MAP)) {
  const from = join(ORIGIN, src), to = join(ROOT, dest);
  if (!existsSync(from)) { drift.push(`${src}: missing in origin ${ORIGIN}`); continue; }
  const bytes = readFileSync(from);
  const same = existsSync(to) && sha(readFileSync(to)) === sha(bytes);
  if (same) { n++; continue; }
  if (CHECK) drift.push(`${dest} differs from ${src}`);
  else { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, bytes); console.log(`  wrote ${dest} ← ${src}`); n++; }
}
if (drift.length) { console.error(`✖ brand assets:\n  ${drift.join('\n  ')}\n  run \`node scripts/sync-brand.mjs\``); process.exit(1); }
console.log(`✔ ${n} brand file(s) under public/ match @companionintelligence/assets (${ORIGIN.includes('node_modules') ? 'installed' : ORIGIN})`);
