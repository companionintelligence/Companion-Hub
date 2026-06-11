const { execSync } = require('node:child_process');

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

execSync('cargo tauri build', options);

if (process.platform !== 'win32') {
  execSync('sh scripts/patch-deb-maintainer-scripts.sh', options);
}
