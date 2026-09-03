const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRYPOINT = path.join(REPO_ROOT, 'scripts', 'start.ts');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const DEFAULT_OUTDIR = path.join(REPO_ROOT, 'dist', 'cli');

const SUPPORTED_TARGETS = [
  {
    rustTarget: 'x86_64-unknown-linux-gnu',
    bunTargets: ['bun-linux-x64', 'bun-linux-x64-baseline', 'bun-linux-x64-modern'],
    defaultBunTarget: 'bun-linux-x64-baseline',
    platformKey: 'linux',
    archKey: 'x64',
    extension: '',
  },
  {
    rustTarget: 'aarch64-unknown-linux-gnu',
    bunTargets: ['bun-linux-arm64'],
    defaultBunTarget: 'bun-linux-arm64',
    platformKey: 'linux',
    archKey: 'arm64',
    extension: '',
  },
  {
    rustTarget: 'x86_64-apple-darwin',
    bunTargets: ['bun-darwin-x64'],
    defaultBunTarget: 'bun-darwin-x64',
    platformKey: 'macos',
    archKey: 'x64',
    extension: '',
  },
  {
    rustTarget: 'aarch64-apple-darwin',
    bunTargets: ['bun-darwin-arm64'],
    defaultBunTarget: 'bun-darwin-arm64',
    platformKey: 'macos',
    archKey: 'arm64',
    extension: '',
  },
  {
    rustTarget: 'x86_64-pc-windows-msvc',
    bunTargets: ['bun-windows-x64', 'bun-windows-x64-baseline', 'bun-windows-x64-modern'],
    defaultBunTarget: 'bun-windows-x64-baseline',
    platformKey: 'windows',
    archKey: 'x64',
    extension: '.exe',
  },
  {
    rustTarget: 'aarch64-pc-windows-msvc',
    bunTargets: ['bun-windows-arm64'],
    defaultBunTarget: 'bun-windows-arm64',
    platformKey: 'windows',
    archKey: 'arm64',
    extension: '.exe',
  },
];

function readPackageVersion() {
  // Release builds pass the tag via CI_HUB_BUILD_VERSION; package.json is not
  // bumped per release, so falling back to it under-reports `cihub version`.
  const buildVersion = (process.env.CI_HUB_BUILD_VERSION || '').trim().replace(/^v/, '');
  if (buildVersion) {
    return buildVersion;
  }
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error(`Could not read version from ${PACKAGE_JSON}`);
  }
  return pkg.version;
}

function detectHostRustTarget() {
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  throw new Error(`Unsupported host platform for standalone CLI build: ${process.platform}/${process.arch}`);
}

function supportedTargetList() {
  return SUPPORTED_TARGETS.map((target) => target.rustTarget).join(', ');
}

function resolveStandaloneTarget(input) {
  const requestedTarget = input || detectHostRustTarget();
  for (const target of SUPPORTED_TARGETS) {
    if (target.rustTarget === requestedTarget) {
      return { ...target, requestedTarget, bunTarget: target.defaultBunTarget };
    }
    if (target.bunTargets.includes(requestedTarget)) {
      return { ...target, requestedTarget, bunTarget: requestedTarget };
    }
  }

  throw new Error(`Unsupported target "${requestedTarget}". Supported targets: ${supportedTargetList()}`);
}

function artifactFilename(target) {
  return `cihub-${target.platformKey}-${target.archKey}${target.extension}`;
}

function resolveOutputPath(target, outdir = DEFAULT_OUTDIR) {
  return path.join(outdir, artifactFilename(target));
}

function bunTargetCandidates(target, allowFallback = true) {
  if (!allowFallback) {
    return [target.bunTarget];
  }

  return [target.bunTarget, ...target.bunTargets.filter((candidate) => candidate !== target.bunTarget)];
}

function requireOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a path value`);
  }
  return value;
}

function parseArgs(argv) {
  let target;
  let outdir = DEFAULT_OUTDIR;
  let outfile;
  let bundleResource = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      target = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
      continue;
    }
    if (arg === '--outdir') {
      outdir = path.resolve(process.cwd(), requireOptionValue(argv, index, '--outdir'));
      index += 1;
      continue;
    }
    if (arg.startsWith('--outdir=')) {
      const value = arg.slice('--outdir='.length);
      if (!value) {
        throw new Error('--outdir requires a path value');
      }
      outdir = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg === '--outfile') {
      outfile = path.resolve(process.cwd(), requireOptionValue(argv, index, '--outfile'));
      index += 1;
      continue;
    }
    if (arg.startsWith('--outfile=')) {
      const value = arg.slice('--outfile='.length);
      if (!value) {
        throw new Error('--outfile requires a path value');
      }
      outfile = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--bundle-resource') {
      bundleResource = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { target, outdir, outfile, bundleResource };
}

function printHelp() {
  console.log(`Build a standalone Companion Hub CLI binary with Bun.

Usage:
  node scripts/build-standalone-cli.cjs [--target <rust-target|bun-target>] [--outdir <dir>] [--outfile <file>] [--bundle-resource]

Options:
  --target <rust-target|bun-target>  Build for a specific standalone target
  --outdir <dir>                     Write the default artifact name into this directory
  --outfile <file>                  Write the binary to an explicit output path
  --bundle-resource                 Strip Unix execute bits so Tauri bundles the CLI as data

Examples:
  node scripts/build-standalone-cli.cjs
  node scripts/build-standalone-cli.cjs --target x86_64-unknown-linux-gnu
  node scripts/build-standalone-cli.cjs --target bun-darwin-arm64 --outdir packages/desktop/src-tauri/resources/cli
  node scripts/build-standalone-cli.cjs --outfile packages/desktop/src-tauri/resources/cihub --bundle-resource
`);
}

function buildStandaloneCli(options = {}) {
  const target = resolveStandaloneTarget(options.target);
  const outdir = options.outdir || DEFAULT_OUTDIR;
  const outfile = options.outfile || resolveOutputPath(target, outdir);
  const allowFallback = !options.target || options.target === target.rustTarget;
  const candidates = bunTargetCandidates(target, allowFallback);
  const version = readPackageVersion();

  mkdirSync(path.dirname(outfile), { recursive: true });
  if (existsSync(outfile)) {
    rmSync(outfile, { force: true });
  }

  let builtTarget = target.bunTarget;

  for (const bunTarget of candidates) {
    const result = spawnSync(
      'bun',
      ['build', '--compile', `--target=${bunTarget}`, '--outfile', outfile, '--define', `CIHUB_BUILD_VERSION=${JSON.stringify(version)}`, ENTRYPOINT],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: process.env,
      },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      builtTarget = bunTarget;
      break;
    }

    rmSync(outfile, { force: true });
    if (allowFallback && bunTarget !== candidates[candidates.length - 1]) {
      console.warn(`bun build failed for ${bunTarget}; trying fallback target...`);
      continue;
    }

    throw new Error(`bun build failed for ${bunTarget} with exit code ${result.status}`);
  }
  if (!existsSync(outfile)) {
    throw new Error(`Standalone CLI build completed without producing ${outfile}`);
  }

  if (options.bundleResource && target.extension !== '.exe') {
    chmodSync(outfile, 0o644);
  }

  return {
    version,
    outfile,
    artifactFilename: artifactFilename(target),
    target: { ...target, bunTarget: builtTarget },
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = buildStandaloneCli(options);
    console.log(`Built standalone CLI ${result.version}: ${result.outfile}`);
  } catch (error) {
    console.error(`Failed to build standalone CLI: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_OUTDIR,
  SUPPORTED_TARGETS,
  artifactFilename,
  bunTargetCandidates,
  buildStandaloneCli,
  detectHostRustTarget,
  parseArgs,
  resolveOutputPath,
  resolveStandaloneTarget,
};
