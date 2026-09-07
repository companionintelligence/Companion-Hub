const { execSync } = require('node:child_process');
const path = require('node:path');

/**
 * WHY THIS REFUSES TO SKIP QUIETLY.
 *
 * Both toolchain checks below used to `console.log` and `process.exit(0)`, so a
 * machine without cargo-tauri produced a build that said nothing was wrong and
 * shipped no desktop app. Nothing downstream could tell that apart from a real
 * build, which is exactly the failure you do not want in a release pipeline.
 *
 * The skip itself was deliberate and is kept: this script runs under the root
 * `turbo run build`, and a contributor working on the frontend should not need a
 * Rust toolchain to build the workspace. What changes is that the skip has to be
 * ASKED FOR rather than inferred from a missing binary.
 *
 *   SKIP_DESKTOP_BUILD=1 pnpm build     # explicit, prints a warning, exits 0
 *   pnpm build                          # no toolchain -> exits 1 and says why
 *
 * Note the desktop CI workflow (.github/workflows/desktop-build.yml) does NOT go
 * through this script — it calls `npx @tauri-apps/cli@2 build` directly — so this
 * guard is for local and root-build use, not for that pipeline.
 */
const SKIP = process.env.SKIP_DESKTOP_BUILD === '1';

function refuse(what, howToInstall) {
  console.error(`\nDesktop build FAILED: ${what}\n`);
  console.error('Install it:');
  for (const line of howToInstall) console.error(`  ${line}`);
  console.error('\nOr skip the desktop package explicitly:');
  console.error('  SKIP_DESKTOP_BUILD=1 pnpm build\n');
  process.exit(1);
}

function skipped(what) {
  console.warn(`\n[!] SKIPPING the desktop build - SKIP_DESKTOP_BUILD=1 and ${what}.`);
  console.warn('    No desktop app was produced. Do not ship this build.\n');
  process.exit(0);
}

function loadCliPathHelper() {
  try {
    return require('../../../scripts/desktop-cli-path.cjs');
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  try {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(probe, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

if (!commandExists('cargo')) {
  if (SKIP) skipped('cargo is not installed');
  refuse('cargo (the Rust toolchain) is not installed.', [
    'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    'https://www.rust-lang.org/tools/install',
  ]);
}

execSync('node ../../scripts/sync-docker-compose-prod.cjs', {
  cwd: process.cwd(),
  stdio: 'inherit',
});

try {
  execSync('cargo tauri --version', {
    cwd: process.cwd(),
    stdio: 'ignore',
    shell: true,
  });
} catch {
  if (SKIP) skipped('cargo-tauri is not installed');
  // Named separately from cargo: "Rust is missing" and "Rust is here but the Tauri
  // CLI is not" need different fixes, and the old message claimed both at once.
  refuse('cargo is installed, but the Tauri CLI (cargo-tauri) is not.', [
    'cargo install tauri-cli --version "^2" --locked',
    'or use the published CLI, as CI does: npx --yes @tauri-apps/cli@2 build',
  ]);
}

const options = {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: true,
};

function resolveTauriBuildCommand() {
  const explicitTargets = process.env.TAURI_BUNDLE_TARGETS?.trim();
  if (explicitTargets) {
    return `cargo tauri build -b ${explicitTargets}`;
  }

  // Local Linux builds often lack linuxdeploy; skip AppImage unless explicitly requested.
  if (process.platform === 'linux') {
    return 'cargo tauri build -b deb,rpm';
  }

  return 'cargo tauri build';
}

const standaloneCliOut = path.resolve(process.cwd(), 'src-tauri/resources', process.platform === 'win32' ? 'cihub.exe' : 'cihub');

execSync(`node ../../scripts/build-standalone-cli.cjs --outfile "${standaloneCliOut}" --bundle-resource`, options);

const tauriBuildCommand = resolveTauriBuildCommand();
console.log(`Running desktop bundle command: ${tauriBuildCommand}`);
execSync(tauriBuildCommand, options);

if (process.platform !== 'win32') {
  execSync('sh scripts/patch-deb-maintainer-scripts.sh', options);
}

const cliPathHelper = loadCliPathHelper();
if (cliPathHelper?.ensureRepoCliOnPath) {
  const cliPath = cliPathHelper.ensureRepoCliOnPath(path.resolve(process.cwd(), '../..'));
  console.log('\nCompanion Hub CLI');
  for (const line of cliPath.messageLines) {
    console.log(`- ${line}`);
  }
}
