const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { ensureRepoCliOnPath } = require('../../../scripts/desktop-cli-path.cjs');

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
  console.log('Skipping desktop build (Rust / cargo-tauri not installed)');
  process.exit(0);
}

try {
  execSync('cargo tauri --version', {
    cwd: process.cwd(),
    stdio: 'ignore',
    shell: true,
  });
} catch {
  console.log('Skipping desktop build (Rust / cargo-tauri not installed)');
  process.exit(0);
}

const options = {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: true,
};

const frontendDist = path.resolve(process.cwd(), '../frontend/dist/client');

if (!existsSync(frontendDist)) {
  console.log(`Frontend build output missing at ${frontendDist}; building frontend first...`);
  execSync('pnpm --dir ../frontend run build', options);
}

execSync('cargo tauri build', options);

if (process.platform !== 'win32') {
  execSync('sh scripts/patch-deb-maintainer-scripts.sh', options);
}

const cliPath = ensureRepoCliOnPath(path.resolve(process.cwd(), '../..'));
console.log('\nCompanion Hub CLI');
for (const line of cliPath.messageLines) {
  console.log(`- ${line}`);
}
