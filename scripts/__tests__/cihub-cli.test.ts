import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appStatusColor,
  BOX_CHARS,
  box,
  buildEnvOverrides,
  ensureLocalDevRuntimeEnv,
  getComposeFiles,
  isApplianceMode,
  isValidApiKeyName,
  isFirstRun,
  isHubRepoRoot,
  mergeComposeProfilesFromEnvFile,
  resolveHubContext,
  normalizeCliArgs,
  normalizeRegisterFlags,
  parseAppRuntimeArgs,
  parseApiKeyScopes,
  parseEnvFile,
  renderBanner,
  renderHelp,
  renderManPage,
  renderStep,
  STEP_ICONS,
  renderVersion,
  renderWizardWelcome,
  shouldRetryApkMirrorWithHostNetwork,
  firstPathFromLookupOutput,
  buildApiKeyInsertSql,
  formatApiKeyRows,
  resolveEnvFromArgs,
  resolveUpStartMode,
  resolveWizardActionInput,
  resolveWizardEnvInput,
  sqlQuote,
  stripAnsi,
  upsertEnvVar,
} from '../cihub-cli';

// --- banner ---

describe('banner', () => {
  it('shows COMPANION HUB and ci.computer in green', () => {
    const plain = stripAnsi(renderBanner());
    expect(plain).toContain('COMPANION HUB');
    expect(plain).toContain('ci.computer');
  });

  it('renders ANSI green colour when FORCE_COLOR is set', () => {
    process.env.FORCE_COLOR = '1';
    const art = renderBanner();
    expect(art).toContain('[32m');
    delete process.env.FORCE_COLOR;
  });

  it('wizard welcome embeds the banner', () => {
    const plain = stripAnsi(renderWizardWelcome());
    expect(plain).toContain('COMPANION HUB');
    expect(plain).toContain('Setup Wizard');
    expect(plain).toContain('cihub man');
  });

  it('box sections have no side | borders on content lines', () => {
    const plain = stripAnsi(renderHelp());
    // Content lines should start with 2-space indent, not ?
    for (const line of plain.split('\n')) {
      if (line.startsWith('  ') && !line.startsWith('  ?') && !line.startsWith('  ?')) {
        expect(line.startsWith('?')).toBe(false);
        expect(line.endsWith('?')).toBe(false);
      }
    }
  });
});

// ??? help & man ???????????????????????????????????????????????????????????????

describe('renderHelp', () => {
  it('lists all command groups', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('Setup & Registration');
    expect(plain).toContain('Hub lifecycle');
    expect(plain).toContain('App lifecycle');
    expect(plain).toContain('MCP');
    expect(plain).toContain('Maintenance');
  });

  it('mentions public-web commands', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('public-web status');
    expect(plain).toContain('public-web repair');
  });

  it('mentions the new app subcommands', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('app status');
    expect(plain).toContain('app logs');
    expect(plain).toContain('app inspect');
    expect(plain).toContain('app stop-managed');
    expect(plain).toContain('app remove-managed');
  });

  it('lists the Models section with install/rm', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('Models');
    expect(plain).toContain('models list');
    expect(plain).toContain('models install');
    expect(plain).toContain('models rm');
  });

  it('documents the device-id command', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('cihub device-id [--from-hub]');
  });

  it('shows the cihub status command', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('cihub status');
    expect(plain).toContain('cihub down');
    expect(plain).toContain('cihub doctor');
  });

  it('documents cihub update as the host update command', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('cihub update [--check]');
    expect(plain).not.toContain('companion-hub update');
  });

  it('shows packaged install instructions', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('npm install -g ci-hub');
    expect(plain).toContain('npx --package ci-hub cihub --help');
  });
});

describe('renderManPage', () => {
  it('has synopsis, description, packaging, and on-device testing sections', () => {
    const plain = stripAnsi(renderManPage());
    expect(plain).toContain('CIHUB(1)');
    expect(plain).toContain('Synopsis');
    expect(plain).toContain('Packaging');
    expect(plain).toContain('On-device testing loop');
  });

  it('uses the direct cihub synopsis', () => {
    const plain = stripAnsi(renderManPage());
    expect(plain).toContain('cihub <command> [args]');
    expect(plain).not.toContain('pnpm run hub --');
  });
});

// --- step renderer ---

describe('renderStep', () => {
  it('shows counter and label', () => {
    const plain = stripAnsi(renderStep(2, 4, 'Installing dependencies'));
    expect(plain).toContain('[2/4]');
    expect(plain).toContain('Installing dependencies');
  });

  it('uses the right icon for each status', () => {
    expect(stripAnsi(renderStep(1, 3, 'x', 'pending'))).toContain(STEP_ICONS.pending);
    expect(stripAnsi(renderStep(1, 3, 'x', 'active'))).toContain(STEP_ICONS.active);
    expect(stripAnsi(renderStep(1, 3, 'x', 'done'))).toContain(STEP_ICONS.done);
    expect(stripAnsi(renderStep(1, 3, 'x', 'fail'))).toContain(STEP_ICONS.fail);
  });
});

// --- version ---

describe('firstPathFromLookupOutput', () => {
  it('returns the first non-empty line from where/which output', () => {
    expect(firstPathFromLookupOutput('C:\\Program Files\\Companion Hub\\companion-hub.exe\r\n')).toBe(
      'C:\\Program Files\\Companion Hub\\companion-hub.exe',
    );
  });

  it('ignores trailing blank lines', () => {
    expect(firstPathFromLookupOutput('/usr/local/bin/companion-hub\n\n')).toBe('/usr/local/bin/companion-hub');
  });

  it('returns undefined for empty output', () => {
    expect(firstPathFromLookupOutput('   \n')).toBeUndefined();
  });
});

describe('renderVersion', () => {
  it('includes the cihub command name', () => {
    expect(renderVersion()).toContain('cihub');
  });

  it('prefers CIHUB_BUILD_VERSION when provided', () => {
    const previous = process.env.CIHUB_BUILD_VERSION;
    process.env.CIHUB_BUILD_VERSION = '9.9.9';
    try {
      expect(renderVersion()).toContain('9.9.9');
    } finally {
      if (previous === undefined) {
        delete process.env.CIHUB_BUILD_VERSION;
      } else {
        process.env.CIHUB_BUILD_VERSION = previous;
      }
    }
  });

  it('reads version from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version?.length).toBeGreaterThan(0);
    expect(renderVersion()).toContain(pkg.version as string);
  });

  it('reads version from the CLI package when cwd is unrelated', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    const previousCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'cihub-cli-version-'));

    try {
      process.chdir(tempDir);
      expect(renderVersion()).toContain(pkg.version as string);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('shouldRetryApkMirrorWithHostNetwork', () => {
  const apkFailure = 'fetch https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/APKINDEX.tar.gz\nERROR: temporary error (try again later)';

  it('only enables automatic Docker host-network retry on Linux', () => {
    expect(shouldRetryApkMirrorWithHostNetwork(apkFailure, {}, 'linux')).toBe(true);
    expect(shouldRetryApkMirrorWithHostNetwork(apkFailure, {}, 'darwin')).toBe(false);
    expect(shouldRetryApkMirrorWithHostNetwork(apkFailure, {}, 'win32')).toBe(false);
  });

  it('does not retry when host networking is already selected', () => {
    expect(shouldRetryApkMirrorWithHostNetwork(apkFailure, { DOCKER_BUILD_NETWORK: 'host' }, 'linux')).toBe(false);
  });
});

// ??? first-run detection ??????????????????????????????????????????????????????

describe('isFirstRun', () => {
  it('returns true when the env file does not exist', () => {
    expect(isFirstRun('__no_such_env_file_xyz__.local')).toBe(true);
  });

  it('returns false when the env file exists', () => {
    const found = existsSync(join(process.cwd(), '.env.local'));
    expect(isFirstRun('.env.local')).toBe(!found);
  });
});

// ??? repo-root guard ???????????????????????????????????????????????????????????

describe('isHubRepoRoot', () => {
  it('recognises the CI-Hub repo from its package.json name + scripts dir', () => {
    expect(isHubRepoRoot(process.cwd())).toBe(true);
  });

  it('returns false for an unrelated directory', () => {
    expect(isHubRepoRoot('/tmp')).toBe(false);
  });

  it('returns false when the directory does not exist', () => {
    expect(isHubRepoRoot('/no/such/dir/__xyz__')).toBe(false);
  });
});

// --- arg helpers ---

describe('normalizeCliArgs', () => {
  it('strips the npm forwarded double dash', () => {
    expect(normalizeCliArgs(['--', '--help'])).toEqual(['--help']);
  });

  it('passes through args that do not start with --', () => {
    expect(normalizeCliArgs(['wizard', 'local'])).toEqual(['wizard', 'local']);
  });
});

describe('resolveEnvFromArgs', () => {
  it('returns local by default when no args', () => {
    expect(resolveEnvFromArgs([])).toBe('local');
  });

  it('picks the named env from the arg list', () => {
    expect(resolveEnvFromArgs(['staging'])).toBe('staging');
    expect(resolveEnvFromArgs(['prod'])).toBe('prod');
    expect(resolveEnvFromArgs(['dev'])).toBe('dev');
  });

  it('rejects unrecognised arguments so typos are caught', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveEnvFromArgs(['lokl'])).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('normalizeRegisterFlags', () => {
  it('parses env, --fresh, and --code flags', () => {
    expect(normalizeRegisterFlags(['dev', '--fresh', '--code', '8XNYEB'])).toEqual({
      env: 'dev',
      fresh: true,
      code: '8XNYEB',
    });
  });

  it('parses --code=value form', () => {
    expect(normalizeRegisterFlags(['--fresh', '--code=ABC123', 'staging'])).toEqual({
      env: 'staging',
      fresh: true,
      code: 'ABC123',
    });
  });

  it('defaults env to local when omitted', () => {
    expect(normalizeRegisterFlags(['--code', 'ABC123'])).toEqual({
      env: 'local',
      fresh: false,
      code: 'ABC123',
    });
  });
});

// --- wizard selections ---

describe('wizard selections', () => {
  it('maps numeric shortcuts to environment names', () => {
    expect(resolveWizardEnvInput('1')).toBe('local');
    expect(resolveWizardEnvInput('2')).toBe('dev');
    expect(resolveWizardEnvInput('3')).toBe('staging');
    expect(resolveWizardEnvInput('4')).toBe('prod');
    expect(resolveWizardEnvInput('')).toBe('local');
  });

  it('maps numeric shortcuts to action keys including new commands', () => {
    expect(resolveWizardActionInput('1')).toBe('setup');
    expect(resolveWizardActionInput('2')).toBe('up');
    expect(resolveWizardActionInput('5')).toBe('mcp-setup');
    expect(resolveWizardActionInput('7')).toBe('down');
    expect(resolveWizardActionInput('9')).toBe('reset');
    expect(resolveWizardActionInput('10')).toBe('restart');
    expect(resolveWizardActionInput('')).toBe('setup');
  });

  it('accepts the spelled-out env names case-insensitively', () => {
    expect(resolveWizardEnvInput('PROD')).toBe('prod');
    expect(resolveWizardEnvInput('  staging  ')).toBe('staging');
  });

  it('exits on an unrecognised env selection', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveWizardEnvInput('99')).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('exits on an unrecognised action selection', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveWizardActionInput('nope')).toThrow();
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// --- stripAnsi ---

describe('stripAnsi', () => {
  it('removes SGR colour and style codes', () => {
    expect(stripAnsi('[32mgreen[0m')).toBe('green');
    expect(stripAnsi('[1m[36mbold cyan[0m')).toBe('bold cyan');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no codes here')).toBe('no codes here');
  });
});

// --- compose file mapping ---

describe('getComposeFiles', () => {
  it('returns the local compose file for local', () => {
    expect(getComposeFiles('local')).toEqual(['docker-compose.local.yml']);
  });

  it('returns the prod compose file for dev and prod', () => {
    expect(getComposeFiles('dev')).toEqual(['docker-compose.prod.yml']);
    expect(getComposeFiles('prod')).toEqual(['docker-compose.prod.yml']);
  });

  it('layers staging on top of prod for staging', () => {
    expect(getComposeFiles('staging')).toEqual(['docker-compose.prod.yml', 'docker-compose.staging.yml']);
  });
});

// ??? env file round-trip ???????????????????????????????????????????????????????

describe('parseEnvFile / upsertEnvVar', () => {
  const TMP = '.env.__vitest__';
  const abs = join(process.cwd(), TMP);

  afterEach(() => {
    if (existsSync(abs)) rmSync(abs);
  });

  it('returns an empty object when the file is missing', () => {
    expect(parseEnvFile('.env.__does_not_exist__')).toEqual({});
  });

  it('round-trips a value through upsert then parse', () => {
    upsertEnvVar(TMP, 'FOO', 'bar');
    expect(parseEnvFile(TMP).FOO).toBe('bar');
  });

  it('replaces an existing key instead of appending a duplicate', () => {
    upsertEnvVar(TMP, 'KEY', 'one');
    upsertEnvVar(TMP, 'KEY', 'two');
    const raw = readFileSync(abs, 'utf-8');
    expect(parseEnvFile(TMP).KEY).toBe('two');
    expect(raw.match(/^KEY=/gm)?.length).toBe(1);
  });

  it('strips surrounding quotes and ignores comments/blank lines', () => {
    upsertEnvVar(TMP, 'A', '"quoted"');
    upsertEnvVar(TMP, 'B', "'single'");
    upsertEnvVar(TMP, 'C', 'plain');
    const vars = parseEnvFile(TMP);
    expect(vars.A).toBe('quoted');
    expect(vars.B).toBe('single');
    expect(vars.C).toBe('plain');
  });

  it('keeps multiple distinct keys', () => {
    upsertEnvVar(TMP, 'X', '1');
    upsertEnvVar(TMP, 'Y', '2');
    const vars = parseEnvFile(TMP);
    expect(vars.X).toBe('1');
    expect(vars.Y).toBe('2');
  });
});

// ??? compose profiles / private-vpn ?????????????????????????????????????????????

describe('mergeComposeProfilesFromEnvFile', () => {
  const TMP = '.env.__vitest_vpn__';
  const abs = join(process.cwd(), TMP);

  afterEach(() => {
    if (existsSync(abs)) rmSync(abs);
    delete process.env.COMPOSE_PROFILES;
  });

  it('adds private-vpn by default when the env file has values but no opt-out', () => {
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', '/tmp/x');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).toContain('private-vpn');
  });

  it('removes private-vpn when PRIVATE_VPN_USER_DISABLED=true', () => {
    upsertEnvVar(TMP, 'PRIVATE_VPN_USER_DISABLED', 'true');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).not.toContain('private-vpn');
  });

  it('keeps private-vpn when legacy PRIVATE_VPN_ENABLED=false is present', () => {
    upsertEnvVar(TMP, 'PRIVATE_VPN_ENABLED', 'false');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).toContain('private-vpn');
  });

  it('preserves existing COMPOSE_PROFILES from the file', () => {
    upsertEnvVar(TMP, 'COMPOSE_PROFILES', 'gpu');
    const profiles = mergeComposeProfilesFromEnvFile(TMP).split(',');
    expect(profiles).toContain('gpu');
    expect(profiles).toContain('private-vpn');
  });

  it('adds cloudflare profile when tunnel/token exists under ROOT_FOLDER_HOST', () => {
    const root = join(process.cwd(), '.internal.__vitest_tunnel__');
    const tokenDir = join(root, '..', 'tunnel');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'token'), 'test-tunnel-token\n', 'utf8');
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', root);
    try {
      expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).toContain('cloudflare');
    } finally {
      rmSync(join(root, '..', 'tunnel'), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildEnvOverrides', () => {
  const TMP = '.env.__vitest_overrides__';
  const abs = join(process.cwd(), TMP);

  afterEach(() => {
    if (existsSync(abs)) rmSync(abs);
    delete process.env.CI_HUB_CONTAINER_UID;
    delete process.env.CI_HUB_CONTAINER_GID;
  });

  it('propagates container UID/GID from the env file when set (Docker Desktop root)', () => {
    upsertEnvVar(TMP, 'CI_HUB_CONTAINER_UID', '0');
    upsertEnvVar(TMP, 'CI_HUB_CONTAINER_GID', '0');
    expect(buildEnvOverrides(TMP)).toMatchObject({
      ENV_FILE: TMP,
      CI_HUB_CONTAINER_UID: '0',
      CI_HUB_CONTAINER_GID: '0',
    });
  });

  it('does not inject host getuid when the env file omits container identity', () => {
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', '/tmp/hub-state');
    const overrides = buildEnvOverrides(TMP);
    expect(overrides.ENV_FILE).toBe(TMP);
    expect(overrides).not.toHaveProperty('CI_HUB_CONTAINER_UID');
    expect(overrides).not.toHaveProperty('CI_HUB_CONTAINER_GID');
  });
});

describe('ensureLocalDevRuntimeEnv', () => {
  const TMP = '.env.__vitest_local_dev__';
  const abs = join(process.cwd(), TMP);
  let rootFolderHost: string;

  beforeEach(() => {
    rootFolderHost = mkdtempSync(join(tmpdir(), 'cihub-local-dev-root-'));
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', rootFolderHost);
  });

  afterEach(() => {
    if (existsSync(abs)) rmSync(abs);
    rmSync(rootFolderHost, { recursive: true, force: true });
  });

  it('defaults CI_HUB_APP_DIR to the repo checkout root when unset', () => {
    const runtimeVars = ensureLocalDevRuntimeEnv(TMP);
    expect(runtimeVars.CI_HUB_APP_DIR).toBe(process.cwd());

    const written = readFileSync(join(rootFolderHost, '.env'), 'utf-8');
    expect(written).toContain(`CI_HUB_APP_DIR=${process.cwd()}`);
  });

  it('honors an explicit CI_HUB_APP_DIR from the source env file', () => {
    upsertEnvVar(TMP, 'CI_HUB_APP_DIR', '/custom/app/dir');
    const runtimeVars = ensureLocalDevRuntimeEnv(TMP);
    expect(runtimeVars.CI_HUB_APP_DIR).toBe('/custom/app/dir');

    const written = readFileSync(join(rootFolderHost, '.env'), 'utf-8');
    expect(written).toContain('CI_HUB_APP_DIR=/custom/app/dir');
  });
});

// --- app runtime arg parsing ---

describe('parseAppRuntimeArgs', () => {
  it('returns empty arrays for no args', () => {
    expect(parseAppRuntimeArgs([])).toEqual({ ports: [], envVars: [] });
  });

  it('collects multiple --port and --env flags in order', () => {
    const r = parseAppRuntimeArgs(['--port', '8080:80', '--env', 'A=1', '--port', '443:443', '--env', 'B=2']);
    expect(r.ports).toEqual(['8080:80', '443:443']);
    expect(r.envVars).toEqual(['A=1', 'B=2']);
  });

  it('exits on an unknown option', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseAppRuntimeArgs(['--bogus'])).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('exits when --port has no value', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseAppRuntimeArgs(['--port'])).toThrow();
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// --- status colour coding ---

describe('appStatusColor', () => {
  beforeEach(() => {
    process.env.FORCE_COLOR = '1';
  });
  afterEach(() => {
    delete process.env.FORCE_COLOR;
  });

  it('colours running containers green', () => {
    expect(appStatusColor('Up 3 hours')).toContain('[32m');
  });

  it('colours exited containers red', () => {
    expect(appStatusColor('Exited (1) 2 minutes ago')).toContain('[31m');
  });

  it('colours paused containers yellow', () => {
    expect(appStatusColor('Paused')).toContain('[33m');
  });

  it('dims unknown statuses', () => {
    expect(appStatusColor('Created')).toContain('[2m');
  });
});

// --- box rendering primitive ---

describe('box', () => {
  it('renders a title header, indented body, and a closing rule', () => {
    const lines = stripAnsi(box('Title', ['line one', 'line two'])).split('\n');
    expect(lines[0]).toContain(`${BOX_CHARS.topLeft}${BOX_CHARS.horizontal} Title`);
    expect(lines[0]).toContain(BOX_CHARS.horizontal);
    expect(lines[1]).toBe('  line one');
    expect(lines[2]).toBe('  line two');
    expect(lines[lines.length - 1]).toContain(BOX_CHARS.bottomLeft);
    expect(lines[lines.length - 1]).toContain(BOX_CHARS.horizontal);
  });

  it('handles an empty body without throwing', () => {
    expect(() => box('Empty', [])).not.toThrow();
  });
});

// --- package metadata ---

describe('package metadata', () => {
  it('publishes the cihub bin entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      bin?: Record<string, string>;
      version?: string;
    };
    expect(pkg.bin?.cihub).toBe('./bin/cihub.cjs');
  });

  it('has a version field', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      version?: string;
    };
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version?.length).toBeGreaterThan(0);
  });
});

// --- appliance (canonical prod) mode ---

describe('appliance mode (run outside a CI-Hub checkout)', () => {
  const ENV_FILE_NAME = process.platform === 'win32' ? '.env' : '.env.dev';
  let previousCwd: string;
  let workDir: string;
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    previousDataDir = process.env.CI_HUB_DATA_DIR;
    // A scratch cwd that is NOT a CI-Hub checkout, plus a separate canonical data dir.
    workDir = mkdtempSync(join(tmpdir(), 'cihub-appliance-cwd-'));
    dataDir = mkdtempSync(join(tmpdir(), 'cihub-appliance-data-'));
    process.env.CI_HUB_DATA_DIR = dataDir;
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousDataDir === undefined) delete process.env.CI_HUB_DATA_DIR;
    else process.env.CI_HUB_DATA_DIR = previousDataDir;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('detects appliance mode when cwd is not a checkout', () => {
    expect(isApplianceMode()).toBe(true);
  });

  it('forces prod and points compose/env at the canonical data dir (absolute paths)', () => {
    const ctx = resolveHubContext('prod');
    expect(ctx.appliance).toBe(true);
    expect(ctx.env).toBe('prod');
    expect(ctx.dataDir).toBe(dataDir);
    expect(ctx.cwd).toBe(dataDir);
    expect(ctx.composeFiles).toEqual([join(dataDir, 'docker-compose.prod.yml')]);
    expect(ctx.envFile).toBe(join(dataDir, ENV_FILE_NAME));
  });

  it('ignores the requested env arg in appliance mode (always prod)', () => {
    expect(resolveHubContext('staging').env).toBe('prod');
    expect(resolveHubContext('local').env).toBe('prod');
  });

  it('defaults up to detached in appliance mode unless --attached is passed', () => {
    expect(resolveUpStartMode('prod', { detached: false, attached: false }, true)).toBe('detached');
    expect(resolveUpStartMode('prod', { detached: false, attached: true }, true)).toBe('attached');
  });
});

describe('resolveHubContext (inside the CI-Hub checkout)', () => {
  it('keeps repo-relative env/compose paths and honors the env arg', () => {
    const ctx = resolveHubContext('prod');
    expect(ctx.appliance).toBe(false);
    expect(ctx.env).toBe('prod');
    expect(ctx.envFile).toBe('.env.prod');
    expect(ctx.composeFiles).toEqual(['docker-compose.prod.yml']);
    expect(ctx.cwd).toBe(process.cwd());
  });
});

// --- api-key ---

describe('api-key name validation', () => {
  it('accepts ordinary operator labels', () => {
    expect(isValidApiKeyName('laptop')).toBe(true);
    expect(isValidApiKeyName('Hanzla MacBook')).toBe(true);
    expect(isValidApiKeyName('ci-runner.01')).toBe(true);
    expect(isValidApiKeyName('user@host')).toBe(true);
  });

  it("rejects the 'app:' prefix reserved for Hub-managed app keys", () => {
    // An operator key named app:* would be indistinguishable from a provisioned managed key in the UI.
    expect(isValidApiKeyName('app:ci-openclaw')).toBe(false);
  });

  it('rejects names that could break out of the SQL string literal', () => {
    expect(isValidApiKeyName("bad'; DROP TABLE api_key; --")).toBe(false);
    expect(isValidApiKeyName("o'brien")).toBe(false);
    expect(isValidApiKeyName('multi\nline')).toBe(false);
  });

  it('rejects empty and over-long names', () => {
    expect(isValidApiKeyName('')).toBe(false);
    expect(isValidApiKeyName('x'.repeat(65))).toBe(false);
    expect(isValidApiKeyName('x'.repeat(64))).toBe(true);
  });

  it('rejects a flag-shaped name, which is what a forgotten --name value looks like', () => {
    // `api-key create --name --scopes mcp` would otherwise mint a key literally named '--scopes'.
    expect(isValidApiKeyName('--scopes')).toBe(false);
    expect(isValidApiKeyName('-laptop')).toBe(false);
    expect(isValidApiKeyName('ci-runner')).toBe(true); // an interior dash is still fine
  });
});

describe('api-key scope parsing', () => {
  it('parses a comma list and tolerates whitespace', () => {
    expect(parseApiKeyScopes(' mcp ')).toEqual({ scopes: ['mcp'], invalid: [], managedOnly: [] });
  });

  it("refuses 'app' separately from an unknown scope — it exists, but only on managed keys", () => {
    // ApiKeyAdminService pins operator keys to ['mcp'] for the same reason: the callback guard
    // resolves a key's owning app, which only app provisioning sets, so an operator 'app' key is dead.
    const { scopes, invalid, managedOnly } = parseApiKeyScopes('mcp,app');
    expect(scopes).toEqual(['mcp', 'app']);
    expect(managedOnly).toEqual(['app']);
    expect(invalid).toEqual([]);
  });

  it('reports unknown scopes rather than silently dropping them', () => {
    const { scopes, invalid, managedOnly } = parseApiKeyScopes('mcp,admin');
    expect(scopes).toEqual(['mcp', 'admin']);
    expect(invalid).toEqual(['admin']);
    expect(managedOnly).toEqual([]);
  });

  it('dedupes and orders like ApiKeyService.normalizeScopes', () => {
    expect(parseApiKeyScopes('mcp,mcp').scopes).toEqual(['mcp']);
  });

  it('returns no scopes for an empty value so the caller can reject it', () => {
    expect(parseApiKeyScopes('').scopes).toEqual([]);
  });
});

describe('buildApiKeyInsertSql', () => {
  const row = { name: 'laptop', scopes: ['mcp'], prefix: 'abc12345', hashedKey: 'f'.repeat(64) };

  it('writes the columns ApiKeyService writes, leaving managed/created_at to their defaults', () => {
    expect(buildApiKeyInsertSql(row)).toBe(
      `INSERT INTO api_key (name, scopes, prefix, hashed_key) VALUES ('laptop', ARRAY['mcp']::text[], 'abc12345', '${'f'.repeat(64)}') RETURNING id;`,
    );
  });

  it('quotes a name the validator would have refused, so the SQL survives one layer failing', () => {
    expect(buildApiKeyInsertSql({ ...row, name: "o'brien" })).toContain("VALUES ('o''brien'");
  });

  it('renders a multi-scope grant as a text[] literal', () => {
    expect(buildApiKeyInsertSql({ ...row, scopes: ['mcp', 'app'] })).toContain("ARRAY['mcp','app']::text[]");
  });
});

describe('sqlQuote', () => {
  it('doubles single quotes so a quoted value cannot terminate early', () => {
    expect(sqlQuote("o'brien")).toBe("'o''brien'");
  });

  it('wraps plain values', () => {
    expect(sqlQuote('laptop')).toBe("'laptop'");
  });
});

describe('formatApiKeyRows', () => {
  it('renders id, name, scopes and prefix', () => {
    const json = JSON.stringify([{ id: 1, name: 'laptop', scopes: ['mcp'], prefix: 'abc12345' }]);

    expect(formatApiKeyRows(json)).toEqual(['1  laptop  [mcp]  abc12345…']);
  });

  it('shows a dash for a full-access key with no scopes', () => {
    const json = JSON.stringify([{ id: 2, name: 'legacy', scopes: [], prefix: 'def67890' }]);

    expect(formatApiKeyRows(json)[0]).toContain('[-]');
  });

  it('collapses whitespace in a name so one key cannot span rows', () => {
    // Names created before this command's validation may contain anything the UI allowed.
    const json = JSON.stringify([{ id: 3, name: 'multi\nline\tname', scopes: ['app'], prefix: 'aaa' }]);

    expect(formatApiKeyRows(json)).toEqual(['3  multi line name  [app]  aaa…']);
  });

  it('returns no rows for an empty result', () => {
    expect(formatApiKeyRows('[]')).toEqual([]);
  });

  it('returns no rows rather than throwing on malformed output', () => {
    expect(formatApiKeyRows('not json')).toEqual([]);
    expect(formatApiKeyRows('')).toEqual([]);
    expect(formatApiKeyRows('{"not":"an array"}')).toEqual([]);
  });
});
