#!/usr/bin/env node
// sync-brand.mjs — the brand files under public/ and src/styles/ci-tokens.css are COPIES of
// CI-Common's @companionintelligence/assets (the org's one logo origin) and
// @companionintelligence/tokens (the canonical design tokens). They are committed so a clone
// builds without a GitHub Packages token; this script is what makes them a mirror rather than
// a second hand-maintained original.
//
// The packages are not in the Hub workspace. Install them first (needs NODE_AUTH_TOKEN with
// read:packages — see tools/ci-common/README.md):
//
//   pnpm run ci-common:install
//
//   node scripts/sync-brand.mjs            # rewrite the copies from tools/ci-common
//   node scripts/sync-brand.mjs --check    # exit 1 if any copy differs from the origin
//   node scripts/sync-brand.mjs --from ../../../CI-Common   # use a CI-Common checkout instead
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // packages/frontend
const TOOLS = resolve(ROOT, '../../tools/ci-common/node_modules/@companionintelligence');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fromIdx = argv.indexOf('--from');
const CHECKOUT = fromIdx === -1 ? null : resolve(argv[fromIdx + 1]);

/** Package → its directory inside a CI-Common checkout (package.json `repository.directory`). */
const CHECKOUT_DIR = { assets: 'assets', tokens: 'styles/tokens' };
const origin = (pkg) => (CHECKOUT ? join(CHECKOUT, CHECKOUT_DIR[pkg]) : join(TOOLS, pkg));

/** Committed path → [package, path inside it]. Logo ids in the assets package's brand.config.json. */
const MAP = {
  'public/logo.svg': ['assets', 'logos/mark-tight.svg'], // logo.mark-tight
  'public/2024_CI__LogoMark_Color_med.svg': ['assets', 'logos/mark.svg'], // logo.mark
  'public/2024_CI__Logo_Banner_Color_small.svg': ['assets', 'logos/lockup.svg'], // logo.lockup
  'public/icons/favicon.svg': ['assets', 'logos/mark-tight.svg'],
  'public/icons/favicon.ico': ['assets', 'icons/png/favicon.ico'],
  'public/icons/favicon-96x96.png': ['assets', 'icons/png/favicon-96.png'],
  'public/icons/apple-touch-icon.png': ['assets', 'icons/png/apple-touch-icon-180.png'],
  'public/icons/web-app-manifest-192x192.png': ['assets', 'icons/png/icon-192.png'],
  'public/icons/web-app-manifest-512x512.png': ['assets', 'icons/png/icon-512.png'],
  'src/styles/ci-tokens.css': ['tokens', 'src/globals.css'],
};

for (const pkg of new Set(Object.values(MAP).map(([p]) => p))) {
  if (!existsSync(origin(pkg))) {
    console.error(
      CHECKOUT
        ? `✖ ${origin(pkg)} not found — --from must point at a CI-Common checkout`
        : `✖ @companionintelligence/${pkg} is not installed — run \`pnpm run ci-common:install\` (see tools/ci-common/README.md)`,
    );
    process.exit(1);
  }
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const drift = [];
let n = 0;
for (const [dest, [pkg, src]] of Object.entries(MAP)) {
  const from = join(origin(pkg), src);
  const to = join(ROOT, dest);
  if (!existsSync(from)) {
    drift.push(`${pkg}/${src}: missing in origin ${origin(pkg)}`);
    continue;
  }
  const bytes = readFileSync(from);
  const same = existsSync(to) && sha(readFileSync(to)) === sha(bytes);
  if (same) {
    n++;
    continue;
  }
  if (CHECK) drift.push(`${dest} differs from ${pkg}/${src}`);
  else {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    console.log(`  wrote ${dest} ← ${pkg}/${src}`);
    n++;
  }
}
if (drift.length) {
  console.error(`✖ brand copies:\n  ${drift.join('\n  ')}\n  run \`node scripts/sync-brand.mjs\``);
  process.exit(1);
}
console.log(`✔ ${n} brand file(s) match @companionintelligence/{assets,tokens} (${CHECKOUT ?? 'tools/ci-common'})`);
