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
  isPlausiblePeerFqdn,
  isValidApiKeyName,
  isFirstRun,
  isHubRepoRoot,
  parsePoolArgs,
  runPoolCommand,
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
import {
  hasCloudflareTunnelToken,
  hasRegisteredCloudflareTunnel,
  hasRegisteredCloudflareTunnelAtDataDir,
  hostPathFromDockerPath,
  setTailscalePersistedStateProbeForTests,
  tailscaledStateLooksLoggedIn,
  TUNNEL_REGISTRATION_MARKER,
} from '../lib/cli-compose-env';
import { parseContextCapArg, parseOllamaSlotsArg, parsePromptCeilingArg } from '../lib/cli-pool';

/**
 * Pool HTTP is stubbed at the `hub-pool-cli` boundary so these tests exercise the parts that live in
 * `cihub-cli.ts` — the confirmation gate, the env-override reporting, and the missing-key guard. The
 * real module is spread back in so the formatters (and every non-pool import) stay genuine.
 */
const poolApi = {
  fetchPoolStatus: vi.fn(),
  fetchPoolPeers: vi.fn(),
  setPoolEnabledSetting: vi.fn(),
  setPoolPeerEnabled: vi.fn(),
  unpairPoolPeer: vi.fn(),
  setPoolMaxPromptTokens: vi.fn(),
  fetchInferencePreferences: vi.fn(),
  setInferenceContextCap: vi.fn(),
  setInferenceOllamaSlots: vi.fn(),
};
let poolApiKey: string | undefined = 'device-key';

vi.mock('../hub-pool-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hub-pool-cli')>()),
  fetchPoolStatus: (...args: unknown[]) => poolApi.fetchPoolStatus(...args),
  fetchPoolPeers: (...args: unknown[]) => poolApi.fetchPoolPeers(...args),
  setPoolEnabledSetting: (...args: unknown[]) => poolApi.setPoolEnabledSetting(...args),
  setPoolPeerEnabled: (...args: unknown[]) => poolApi.setPoolPeerEnabled(...args),
  unpairPoolPeer: (...args: unknown[]) => poolApi.unpairPoolPeer(...args),
  setPoolMaxPromptTokens: (...args: unknown[]) => poolApi.setPoolMaxPromptTokens(...args),
  fetchInferencePreferences: (...args: unknown[]) => poolApi.fetchInferencePreferences(...args),
  setInferenceContextCap: (...args: unknown[]) => poolApi.setInferenceContextCap(...args),
  setInferenceOllamaSlots: (...args: unknown[]) => poolApi.setInferenceOllamaSlots(...args),
}));

vi.mock('../public-web-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-web-cli')>()),
  readHubApiKey: () => poolApiKey,
  readHubApiKeySource: () => (poolApiKey ? { key: poolApiKey, checked: [] } : { checked: ['/fake/.internal/state/settings.json'] }),
}));

/** The doctor itself is covered in pool-diagnostics-cli.test.ts; what is under test here is the wiring. */
const doctorSection = { lines: ['Hub Pool preflight  all 13 checks passed'], issueCount: 0, failureCount: 0, remediationCommands: [] as string[] };
const runPoolDoctorSection = vi.fn(async (..._args: unknown[]) => doctorSection);
vi.mock('../pool-diagnostics-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pool-diagnostics-cli')>()),
  runPoolDoctorSection: (...args: unknown[]) => runPoolDoctorSection(...(args as [])),
}));

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

  it('box sections have no side borders on content lines', () => {
    // `box()` frames with a top and bottom rule only (BOX_CHARS has no `vertical`), so a content
    // line is a plain two-space indent. The guard is against a vertical border creeping back in and
    // making every line width-dependent — it is NOT about question marks, which are ordinary text.
    const VERTICAL = '\u2502';
    const plain = stripAnsi(renderHelp());
    for (const line of plain.split('\n')) {
      expect(line.startsWith(VERTICAL)).toBe(false);
      expect(line.trimEnd().endsWith(VERTICAL)).toBe(false);
    }
  });
});

// --- help & man ----------------------------------------------------------------------------------

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

  it('mentions every pool subcommand in help and man', () => {
    for (const rendered of [stripAnsi(renderHelp()), stripAnsi(renderManPage())]) {
      expect(rendered).toContain('Hub Pool');
      expect(rendered).toContain('pool status');
      expect(rendered).toContain('pool peers');
      expect(rendered).toContain('pool discover');
      expect(rendered).toContain('pool pair');
      expect(rendered).toContain('pool approve|reject');
      expect(rendered).toContain('pool unpair');
      expect(rendered).toContain('pool log');
      expect(rendered).toContain('pool enable|disable');
      expect(rendered).toContain('pool pin');
      expect(rendered).toContain('pool unpin');
    }
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

  it('documents that up prompts for a password after a reset', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('prompts for a password after a reset');
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

// --- first-run detection -------------------------------------------------------------------------

describe('isFirstRun', () => {
  it('returns true when the env file does not exist', () => {
    expect(isFirstRun('__no_such_env_file_xyz__.local')).toBe(true);
  });

  it('returns false when the env file exists', () => {
    const found = existsSync(join(process.cwd(), '.env.local'));
    expect(isFirstRun('.env.local')).toBe(!found);
  });
});

// --- repo-root guard -----------------------------------------------------------------------------

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
      move: false,
    });
  });

  it('parses --code=value form', () => {
    expect(normalizeRegisterFlags(['--fresh', '--code=ABC123', 'staging'])).toEqual({
      env: 'staging',
      fresh: true,
      code: 'ABC123',
      move: false,
    });
  });

  it('defaults env to local when omitted', () => {
    expect(normalizeRegisterFlags(['--code', 'ABC123'])).toEqual({
      env: 'local',
      fresh: false,
      code: 'ABC123',
      move: false,
    });
  });

  it('parses --move, the yes to moving this Hub from another organization', () => {
    expect(normalizeRegisterFlags(['--code', 'ABC123', '--move'])).toMatchObject({ code: 'ABC123', move: true });
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
    const prodFiles = getComposeFiles('prod');
    if (existsSync('.env.prod') && /^CI_HUB_IMAGE=\S/m.test(readFileSync('.env.prod', 'utf-8'))) {
      expect(prodFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.dev-image.yml']);
      return;
    }
    expect(prodFiles).toEqual(['docker-compose.prod.yml']);
  });

  it('layers dev-image on prod for dev when CI_HUB_IMAGE is set in .env.dev', () => {
    const devFiles = getComposeFiles('dev');
    if (existsSync('.env.dev')) {
      const devEnv = readFileSync('.env.dev', 'utf-8');
      if (/^CI_HUB_IMAGE=/m.test(devEnv)) {
        expect(devFiles).toEqual(['docker-compose.prod.yml', 'docker-compose.dev-image.yml']);
        return;
      }
    }
    expect(devFiles).toEqual(['docker-compose.prod.yml']);
  });

  it('layers staging on top of prod for staging', () => {
    expect(getComposeFiles('staging')).toEqual(['docker-compose.prod.yml', 'docker-compose.staging.yml']);
  });
});

// --- env file round-trip -------------------------------------------------------------------------

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

// --- compose profiles / private-vpn --------------------------------------------------------------

describe('mergeComposeProfilesFromEnvFile', () => {
  const TMP = '.env.__vitest_vpn__';
  const abs = join(process.cwd(), TMP);

  beforeEach(() => {
    setTailscalePersistedStateProbeForTests(() => false);
  });

  afterEach(() => {
    setTailscalePersistedStateProbeForTests(null);
    if (existsSync(abs)) rmSync(abs);
    delete process.env.COMPOSE_PROFILES;
  });

  it('does not add private-vpn without Tailscale auth key or persisted state', () => {
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', '/tmp/x');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).not.toContain('private-vpn');
  });

  it('adds private-vpn when TAILSCALE_AUTHKEY is set', () => {
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', '/tmp/x');
    upsertEnvVar(TMP, 'TAILSCALE_AUTHKEY', 'tskey-auth-test');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).toContain('private-vpn');
  });

  it('removes private-vpn when PRIVATE_VPN_USER_DISABLED=true even with an auth key', () => {
    upsertEnvVar(TMP, 'TAILSCALE_AUTHKEY', 'tskey-auth-test');
    upsertEnvVar(TMP, 'PRIVATE_VPN_USER_DISABLED', 'true');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).not.toContain('private-vpn');
  });

  it('does not treat legacy PRIVATE_VPN_ENABLED=false as an enable signal', () => {
    upsertEnvVar(TMP, 'PRIVATE_VPN_ENABLED', 'false');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).not.toContain('private-vpn');
  });

  it('preserves existing COMPOSE_PROFILES from the file without forcing private-vpn', () => {
    upsertEnvVar(TMP, 'COMPOSE_PROFILES', 'gpu');
    const profiles = mergeComposeProfilesFromEnvFile(TMP).split(',');
    expect(profiles).toContain('gpu');
    expect(profiles).not.toContain('private-vpn');
  });

  it('drops a private-vpn the file carries when nothing justifies it any more', () => {
    // beta-max 2026-09-15: the file said private-vpn, there was no auth key, and the volume held a
    // logged-out state — every `cihub up` kept a sidecar alive that could never log in.
    upsertEnvVar(TMP, 'COMPOSE_PROFILES', 'private-vpn');
    expect(mergeComposeProfilesFromEnvFile(TMP).split(',')).not.toContain('private-vpn');
  });
});

// --- compose profiles / cloudflare follows registration -----------------------------------------

/** A Hub data dir inside its own temp folder, so the sibling `../tunnel` never lands in the checkout. */
function makeTunnelFixture() {
  const base = mkdtempSync(join(tmpdir(), 'cihub-tunnel-profile-'));
  const root = join(base, 'hub');
  mkdirSync(root, { recursive: true });
  const siblingDir = join(base, 'tunnel');
  const legacyDir = join(root, 'tunnel');
  const write = (dir: string, name: string, contents: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), contents, 'utf8');
  };
  return {
    base,
    root,
    siblingDir,
    legacyDir,
    writeToken: (dir: string, contents = 'tunnel-token\n') => write(dir, 'token', contents),
    writeMarker: (dir: string) => write(dir, TUNNEL_REGISTRATION_MARKER, '{"tunnelId":"tunnel-1","writtenAt":"2026-09-17T00:00:00.000Z"}'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('cloudflare compose profile', () => {
  const TMP = '.env.__vitest_tunnel_profile__';
  const abs = join(process.cwd(), TMP);
  let fixture: ReturnType<typeof makeTunnelFixture>;
  let shellRootFolderHost: string | undefined;

  beforeEach(() => {
    setTailscalePersistedStateProbeForTests(() => false);
    fixture = makeTunnelFixture();
    // A shell ROOT_FOLDER_HOST outranks the env file and would point these checks at a real install.
    shellRootFolderHost = process.env.ROOT_FOLDER_HOST;
    delete process.env.ROOT_FOLDER_HOST;
  });

  afterEach(() => {
    setTailscalePersistedStateProbeForTests(null);
    if (existsSync(abs)) rmSync(abs);
    delete process.env.COMPOSE_PROFILES;
    if (shellRootFolderHost === undefined) delete process.env.ROOT_FOLDER_HOST;
    else process.env.ROOT_FOLDER_HOST = shellRootFolderHost;
    fixture.cleanup();
  });

  const profilesFor = () => mergeComposeProfilesFromEnvFile(TMP).split(',');

  it('stays off for a token without the registration marker (leftover from an uninstalled or reset Hub)', () => {
    fixture.writeToken(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).not.toContain('cloudflare');
    expect(hasRegisteredCloudflareTunnel(TMP)).toBe(false);
    expect(hasCloudflareTunnelToken(TMP)).toBe(true);
  });

  it('stays off for the registration marker without a token', () => {
    fixture.writeMarker(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).not.toContain('cloudflare');
  });

  it('stays off for an empty token beside the registration marker', () => {
    fixture.writeToken(fixture.siblingDir, '');
    fixture.writeMarker(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).not.toContain('cloudflare');
  });

  it('turns on for a token and the registration marker beside ROOT_FOLDER_HOST (sibling)', () => {
    fixture.writeToken(fixture.siblingDir);
    fixture.writeMarker(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).toContain('cloudflare');
    expect(hasRegisteredCloudflareTunnelAtDataDir(fixture.root)).toBe(true);
  });

  it('turns on for a token and the registration marker in the legacy nested ROOT_FOLDER_HOST/tunnel', () => {
    fixture.writeToken(fixture.legacyDir);
    fixture.writeMarker(fixture.legacyDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).toContain('cloudflare');
  });

  it('stays off for a legacy nested token without the marker', () => {
    fixture.writeToken(fixture.legacyDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).not.toContain('cloudflare');
  });

  it('needs the token and the marker in the same tunnel dir', () => {
    fixture.writeToken(fixture.siblingDir);
    fixture.writeMarker(fixture.legacyDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    expect(profilesFor()).not.toContain('cloudflare');

    const reversed = makeTunnelFixture();
    try {
      reversed.writeToken(reversed.legacyDir);
      reversed.writeMarker(reversed.siblingDir);
      expect(hasRegisteredCloudflareTunnelAtDataDir(reversed.root)).toBe(false);
    } finally {
      reversed.cleanup();
    }
  });

  it('drops a cloudflare profile the env file or shell still names once the Hub is not registered', () => {
    fixture.writeToken(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    upsertEnvVar(TMP, 'COMPOSE_PROFILES', 'gpu,cloudflare');
    process.env.COMPOSE_PROFILES = 'cloudflare';
    expect(profilesFor()).toEqual(['gpu']);
  });

  it('applies the same rule before an env file exists', () => {
    fixture.writeToken(fixture.siblingDir);
    process.env.ROOT_FOLDER_HOST = fixture.root;
    process.env.COMPOSE_PROFILES = 'cloudflare';
    expect(profilesFor()).not.toContain('cloudflare');

    fixture.writeMarker(fixture.siblingDir);
    expect(profilesFor()).toContain('cloudflare');
  });

  it('passes an empty COMPOSE_PROFILES so Compose cannot fall back to the env file value', () => {
    fixture.writeToken(fixture.siblingDir);
    upsertEnvVar(TMP, 'ROOT_FOLDER_HOST', fixture.root);
    upsertEnvVar(TMP, 'COMPOSE_PROFILES', 'cloudflare');
    const overrides = buildEnvOverrides(TMP);
    expect(overrides).toHaveProperty('COMPOSE_PROFILES', '');
  });
});

/**
 * On Windows the desktop writes `ROOT_FOLDER_HOST` in Docker's form. Read as-is, Node resolves it
 * against the current drive, the tunnel files are never found, and the CLI drops the `cloudflare`
 * profile the desktop app kept for a registered Hub.
 */
describe('hostPathFromDockerPath', () => {
  it('turns the Docker Desktop and WSL2 engine forms into the native Windows path', () => {
    const native = 'C:\\Users\\hub\\AppData\\Roaming\\companion-hub';
    expect(hostPathFromDockerPath('/c/Users/hub/AppData/Roaming/companion-hub', 'win32')).toBe(native);
    expect(hostPathFromDockerPath('/mnt/c/Users/hub/AppData/Roaming/companion-hub', 'win32')).toBe(native);
    expect(hostPathFromDockerPath('/D/hub', 'win32')).toBe('D:\\hub');
    expect(hostPathFromDockerPath('/c', 'win32')).toBe('C:\\');
  });

  it('leaves native Windows paths and every non-Windows path alone', () => {
    expect(hostPathFromDockerPath('C:\\Users\\hub\\companion-hub', 'win32')).toBe('C:\\Users\\hub\\companion-hub');
    expect(hostPathFromDockerPath('/var/lib/companion-hub', 'win32')).toBe('/var/lib/companion-hub');
    expect(hostPathFromDockerPath('/c/Users/hub/companion-hub', 'linux')).toBe('/c/Users/hub/companion-hub');
    expect(hostPathFromDockerPath('/mnt/c/Users/hub/companion-hub', 'darwin')).toBe('/mnt/c/Users/hub/companion-hub');
  });
});

describe('tailscaledStateLooksLoggedIn', () => {
  it('needs a current profile, not just the machine key tailscaled writes on first start', () => {
    expect(tailscaledStateLooksLoggedIn('{"_machinekey":"cHJpdmtleQ=="}')).toBe(false);
    expect(tailscaledStateLooksLoggedIn('{"_machinekey":"x","_current-profile":""}')).toBe(false);
    expect(tailscaledStateLooksLoggedIn('{"_machinekey":"x","_current-profile":"cHJvZmlsZS0xMjM0","_profiles":"e30=","profile-1234":"e30="}')).toBe(
      true,
    );
  });

  it('treats an unreadable or empty file as logged out', () => {
    expect(tailscaledStateLooksLoggedIn('')).toBe(false);
    expect(tailscaledStateLooksLoggedIn('not json')).toBe(false);
    expect(tailscaledStateLooksLoggedIn('[]')).toBe(false);
  });
});

describe('buildEnvOverrides', () => {
  const TMP = '.env.__vitest_overrides__';
  const abs = join(process.cwd(), TMP);

  // The profile merge otherwise runs `docker run` against the machine's real Tailscale state volume.
  beforeEach(() => {
    setTailscalePersistedStateProbeForTests(() => false);
  });

  afterEach(() => {
    setTailscalePersistedStateProbeForTests(null);
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

  it('accepts qa:read as an operator scope rather than reporting it unknown', () => {
    expect(parseApiKeyScopes('qa:read')).toEqual({ scopes: ['qa:read'], invalid: [], managedOnly: [] });
  });

  it('accepts inference as an operator scope rather than reporting it unknown', () => {
    expect(parseApiKeyScopes('inference')).toEqual({ scopes: ['inference'], invalid: [], managedOnly: [] });
  });

  it('dedupes and orders like ApiKeyService.normalizeScopes', () => {
    expect(parseApiKeyScopes('mcp,mcp').scopes).toEqual(['mcp']);
    // The backend list is ['mcp', 'app', 'qa:read', 'inference']; the operator subset must sort the
    // same way, or a row this command writes would differ from one the service wrote for the same grant.
    expect(parseApiKeyScopes('inference,qa:read,mcp').scopes).toEqual(['mcp', 'qa:read', 'inference']);
  });

  it('returns no scopes for an empty value so the caller can reject it', () => {
    expect(parseApiKeyScopes('').scopes).toEqual([]);
  });
});

describe('buildApiKeyInsertSql', () => {
  const row = { name: 'laptop', scopes: ['mcp'], capability: 'write', prefix: 'abc12345', hashedKey: 'f'.repeat(64) };

  it('writes the columns ApiKeyService writes, leaving managed/created_at to their defaults', () => {
    expect(buildApiKeyInsertSql(row)).toBe(
      "INSERT INTO api_key (name, scopes, capability, prefix, hashed_key) VALUES ('laptop', ARRAY['mcp']::text[], " +
        `'write', 'abc12345', '${'f'.repeat(64)}') RETURNING id;`,
    );
  });

  it('writes the capability it was given, so a read-only key is minted read-only', () => {
    expect(buildApiKeyInsertSql({ ...row, capability: 'read' })).toContain("::text[], 'read',");
  });

  it('quotes a name the validator would have refused, so the SQL survives one layer failing', () => {
    expect(buildApiKeyInsertSql({ ...row, name: "o'brien" })).toContain("VALUES ('o''brien'");
  });

  it('renders a multi-scope grant as a text[] literal', () => {
    expect(buildApiKeyInsertSql({ ...row, scopes: ['mcp', 'app'] })).toContain("ARRAY['mcp','app']::text[]");
  });

  // Verified against a live 0.2.47 appliance: the column arrived after several published
  // releases, and inserting it there fails with `column "capability" ... does not exist`,
  // taking out the headless minting route on exactly the Hubs that most need it.
  it('omits capability on a Hub whose api_key table predates the column', () => {
    const sql = buildApiKeyInsertSql({ ...row, withCapability: false });
    expect(sql).toBe(
      "INSERT INTO api_key (name, scopes, prefix, hashed_key) VALUES ('laptop', ARRAY['mcp']::text[], " +
        `'abc12345', '${'f'.repeat(64)}') RETURNING id;`,
    );
    expect(sql).not.toContain('capability');
  });

  it('still writes capability when the column is present', () => {
    expect(buildApiKeyInsertSql({ ...row, withCapability: true })).toContain('capability');
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
  it('renders id, name, scopes, capability and prefix', () => {
    const json = JSON.stringify([{ id: 1, name: 'laptop', scopes: ['mcp'], capability: 'read', prefix: 'abc12345' }]);

    expect(formatApiKeyRows(json)).toEqual(['1  laptop  [mcp]  read  abc12345…']);
  });

  it("falls back to 'write' for a row predating the column, rather than showing a blank", () => {
    // A listing that omitted the level would make an unrestricted key look restricted, or the
    // reverse — both worse than naming the column default the database would have applied.
    const json = JSON.stringify([{ id: 9, name: 'legacy', scopes: ['mcp'], prefix: 'abc12345' }]);

    expect(formatApiKeyRows(json)).toEqual(['9  legacy  [mcp]  write  abc12345…']);
  });

  it('shows a dash for a full-access key with no scopes', () => {
    const json = JSON.stringify([{ id: 2, name: 'legacy', scopes: [], prefix: 'def67890' }]);

    expect(formatApiKeyRows(json)[0]).toContain('[-]');
  });

  it('collapses whitespace in a name so one key cannot span rows', () => {
    // Names created before this command's validation may contain anything the UI allowed.
    const json = JSON.stringify([{ id: 3, name: 'multi\nline\tname', scopes: ['app'], capability: 'write', prefix: 'aaa' }]);

    expect(formatApiKeyRows(json)).toEqual(['3  multi line name  [app]  write  aaa…']);
  });

  it('strips terminal escapes from a name rather than writing them to the terminal', () => {
    // The UI's create body is `z.string().trim().min(1).max(100)` — no character restriction — so a
    // stored name can carry ANSI/control characters. Rendering them would let a key name clear the
    // screen, recolour output, or forge box rows.
    const esc = String.fromCharCode(27);
    const json = JSON.stringify([
      { id: 4, name: `${esc}[31mred${esc}[0m`, scopes: ['mcp'], capability: 'write', prefix: 'bbb' },
      { id: 5, name: `wipe${esc}[2J${esc}`, scopes: ['mcp'], capability: 'write', prefix: 'ccc' },
    ]);

    const rows = formatApiKeyRows(json);

    expect(rows).toEqual(['4  red  [mcp]  write  bbb…', '5  wipe[2J  [mcp]  write  ccc…']);
    expect(rows.join('')).not.toContain(esc);
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

describe('formatApiKeyRows on a Hub without per-key capability', () => {
  const row = JSON.stringify([{ id: 1, name: 'laptop', scopes: ['mcp'], prefix: 'abc12345' }]);

  // Defaulting to 'write' there would state a restriction the server does not enforce —
  // no published Hub has the column, so every key is bounded by its scopes alone.
  it('omits capability rather than inventing the column default', () => {
    const [line] = formatApiKeyRows(row, false);
    expect(line).not.toMatch(/write|read|full/);
    expect(line).toContain('laptop');
    expect(line).toContain('[mcp]');
  });

  it('still reports capability when the Hub has it', () => {
    const withCap = JSON.stringify([{ id: 1, name: 'laptop', scopes: ['mcp'], capability: 'read', prefix: 'abc12345' }]);
    expect(formatApiKeyRows(withCap, true)[0]).toContain('read');
  });
});

// --- hub pool ---

// Placeholder tailnet names only — docs/README.md tip-scrub policy.
const POOL_PEER_FQDN = 'hub-b.example-tailnet.ts.net';

describe('parsePoolArgs', () => {
  it('defaults to status on the local env', () => {
    expect(parsePoolArgs([])).toEqual({
      subcommand: 'status',
      target: undefined,
      displayName: undefined,
      pin: undefined,
      limit: undefined,
      axis: 'both',
      model: undefined,
      checkLatency: false,
      yes: false,
      env: 'local',
    });
  });

  it('routes pairing-pin, the command the other Hub needs before it can pair by address', () => {
    // It was documented, and named in `pool probe`'s own output, long before it was routed: a
    // headless appliance with no dashboard has no other way to mint one.
    expect(parsePoolArgs(['pairing-pin']).subcommand).toBe('pairing-pin');
    expect(parsePoolArgs(['pairing-pin', 'dev']).env).toBe('dev');
  });

  it('routes cancel-pin as its own subcommand, not a flag on pairing-pin', () => {
    // Revoking is spelled `cancel-pin` rather than `pairing-pin --cancel`; a stray `--cancel` is an
    // unknown flag, so following an older note fails loudly instead of silently minting a PIN.
    expect(parsePoolArgs(['cancel-pin']).subcommand).toBe('cancel-pin');
    expect(parsePoolArgs(['cancel-pin', 'dev']).env).toBe('dev');
    expect(() => parsePoolArgs(['pairing-pin', '--cancel'])).toThrow();
  });

  it('reads --outbound / --inbound into the axis, defaulting to the master switch', () => {
    expect(parsePoolArgs(['disable']).axis).toBe('both');
    expect(parsePoolArgs(['disable', '--outbound']).axis).toBe('outbound');
    expect(parsePoolArgs(['enable', '--inbound']).axis).toBe('inbound');
  });

  it('rejects a direction flag where it would silently do nothing', () => {
    // Naming both would have to mean "the master", which passing neither already means.
    expect(() => parsePoolArgs(['disable', '--outbound', '--inbound'])).toThrow();
    expect(() => parsePoolArgs(['status', '--outbound'])).toThrow();
  });

  it('takes a peer reference for the per-peer switches, before the optional env', () => {
    const parsed = parsePoolArgs(['peer-disable', 'aaaaaaaa', 'dev', '--yes']);
    expect(parsed).toMatchObject({ subcommand: 'peer-disable', target: 'aaaaaaaa', env: 'dev', yes: true });
  });

  it('reads the env argument after a targetless subcommand', () => {
    expect(parsePoolArgs(['peers', 'dev']).env).toBe('dev');
  });

  it('accepts doctor as a subcommand, and reads the env after it rather than a peer reference', () => {
    // `doctor` must NOT be a target subcommand: if it were, `cihub pool doctor prod` would read
    // `prod` as a peer to diagnose and then fall back to the local env.
    expect(parsePoolArgs(['doctor', 'prod'])).toMatchObject({ subcommand: 'doctor', target: undefined, env: 'prod' });
  });

  it('reads --check-latency, and only for doctor', () => {
    expect(parsePoolArgs(['doctor', '--check-latency']).checkLatency).toBe(true);
    expect(parsePoolArgs(['doctor']).checkLatency).toBe(false);
    // The flag spends GPU time; anywhere else it would silently do nothing.
    expect(() => parsePoolArgs(['status', '--check-latency'])).toThrow();
  });

  it('takes the peer reference before the env for target subcommands', () => {
    const parsed = parsePoolArgs(['pair', POOL_PEER_FQDN, 'dev', '--name', 'Studio', '--yes']);
    expect(parsed).toMatchObject({ subcommand: 'pair', target: POOL_PEER_FQDN, displayName: 'Studio', yes: true, env: 'dev' });
  });

  it('reads --pin in both forms, for pairing with a Hub found by address', () => {
    // An address can reach the other Hub but cannot name it — `/identify` reports no MagicDNS name —
    // so the PIN is what makes the answer carry one.
    expect(parsePoolArgs(['pair', '192.168.1.42:5002', '--pin', '123456']).pin).toBe('123456');
    expect(parsePoolArgs(['pair', '192.168.1.42', '--pin=004200']).pin).toBe('004200');
  });

  it('rejects a PIN that is not six digits, and one on a subcommand that has no use for it', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A leading zero is legal, a five-digit value is not, and a PIN on `status` is a typo.
    expect(() => parsePoolArgs(['pair', '192.168.1.42', '--pin', '12345'])).toThrow();
    expect(() => parsePoolArgs(['status', '--pin', '123456'])).toThrow();

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('reads --model in both forms for pin and unpin, and nowhere else', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(parsePoolArgs(['pin', 'local', '--model', 'llama3.2:3b'])).toMatchObject({ subcommand: 'pin', target: 'local', model: 'llama3.2:3b' });
    // Verbatim: a model id is compared case-sensitively against the engine's inventory.
    expect(parsePoolArgs(['unpin', '--model=hf.co/Org/Repo:Q4_K_M']).model).toBe('hf.co/Org/Repo:Q4_K_M');
    expect(parsePoolArgs(['unpin']).model).toBeUndefined();
    expect(() => parsePoolArgs(['status', '--model', 'llama3.2:3b'])).toThrow();

    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('takes the pin target before the env, and unpin takes no target', () => {
    expect(parsePoolArgs(['pin', POOL_PEER_FQDN, 'dev', '--yes'])).toMatchObject({ target: POOL_PEER_FQDN, env: 'dev', yes: true });
    expect(parsePoolArgs(['unpin', 'dev'])).toMatchObject({ subcommand: 'unpin', target: undefined, env: 'dev' });
  });

  it('takes the ceiling value where a peer reference would go, so the env after it still parses', () => {
    expect(parsePoolArgs(['ceiling', '16000', 'dev', '--yes'])).toMatchObject({ subcommand: 'ceiling', target: '16000', env: 'dev', yes: true });
    expect(parsePoolArgs(['ceiling', 'clear'])).toMatchObject({ subcommand: 'ceiling', target: 'clear', env: 'local' });
  });

  it('takes the context cap the same way', () => {
    expect(parsePoolArgs(['context-cap', '16384', 'dev', '--yes'])).toMatchObject({
      subcommand: 'context-cap',
      target: '16384',
      env: 'dev',
      yes: true,
    });
    expect(parsePoolArgs(['context-cap', 'clear'])).toMatchObject({ subcommand: 'context-cap', target: 'clear', env: 'local' });
  });

  it('takes the slot count the same way', () => {
    expect(parsePoolArgs(['slots', '4', 'dev', '--yes'])).toMatchObject({ subcommand: 'slots', target: '4', env: 'dev', yes: true });
    expect(parsePoolArgs(['slots', 'clear'])).toMatchObject({ subcommand: 'slots', target: 'clear', env: 'local' });
  });

  it('accepts --limit in both forms', () => {
    expect(parsePoolArgs(['log', '--limit', '25']).limit).toBe(25);
    expect(parsePoolArgs(['log', '--limit=25']).limit).toBe(25);
  });

  it('exits on an unknown subcommand, unknown flag, or out-of-range limit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => parsePoolArgs(['bogus'])).toThrow();
    expect(() => parsePoolArgs(['status', '--bogus'])).toThrow();
    expect(() => parsePoolArgs(['log', '--limit', '0'])).toThrow();
    expect(() => parsePoolArgs(['log', '--limit', '201'])).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('parsePromptCeilingArg', () => {
  it('reads a whole number of tokens within the Hub’s bounds, and `clear` as no ceiling', () => {
    expect(parsePromptCeilingArg('16000')).toBe(16_000);
    expect(parsePromptCeilingArg(' 1024 ')).toBe(1024);
    expect(parsePromptCeilingArg('1048576')).toBe(1_048_576);
    expect(parsePromptCeilingArg('clear')).toBeNull();
    expect(parsePromptCeilingArg('CLEAR')).toBeNull();
  });

  it.each([
    ['16k'],
    ['16,000'],
    ['16000.5'],
    ['-16000'],
    ['16'],
    ['1023'],
    ['1048577'],
    [''],
    [undefined],
  ])('refuses %s here, before it can become a 400 or a ceiling nobody meant', (raw) => {
    expect(parsePromptCeilingArg(raw)).toBeUndefined();
  });
});

describe('parseContextCapArg', () => {
  it('reads a whole number of tokens within the Hub’s bounds, and `clear` as no cap', () => {
    expect(parseContextCapArg('16384')).toBe(16_384);
    expect(parseContextCapArg(' 2048 ')).toBe(2048);
    expect(parseContextCapArg('1048576')).toBe(1_048_576);
    expect(parseContextCapArg('clear')).toBeNull();
    expect(parseContextCapArg('CLEAR')).toBeNull();
  });

  // The Hub's floor is 2048, not the ceiling's 1024: below it no agent turn fits, and a dropped digit
  // is the likelier explanation. `16k` is refused for the reason the ceiling refuses it.
  it.each([
    undefined,
    '',
    '16k',
    '16384.0',
    '-16384',
    '1024',
    '2047',
    '1048577',
    '0x4000',
    'none',
  ])('refuses %s here, before it can become a 400 or a cap nobody meant', (raw) => {
    expect(parseContextCapArg(raw)).toBeUndefined();
  });
});

describe('parseOllamaSlotsArg', () => {
  it('reads a whole number within --ollama-parallel’s bounds, and `clear` as not stated', () => {
    expect(parseOllamaSlotsArg('4')).toBe(4);
    expect(parseOllamaSlotsArg(' 1 ')).toBe(1);
    expect(parseOllamaSlotsArg('64')).toBe(64);
    expect(parseOllamaSlotsArg('clear')).toBeNull();
    expect(parseOllamaSlotsArg('CLEAR')).toBeNull();
  });

  it.each([undefined, '', '0', '65', '-4', '4.0', '2x', 'none'])('refuses %s here, before it can become a 400', (raw) => {
    expect(parseOllamaSlotsArg(raw)).toBeUndefined();
  });
});

describe('isPlausiblePeerFqdn', () => {
  it('accepts a MagicDNS name and rejects anything carrying a scheme, port, path or address', () => {
    expect(isPlausiblePeerFqdn(POOL_PEER_FQDN)).toBe(true);
    expect(isPlausiblePeerFqdn(`${POOL_PEER_FQDN}.`)).toBe(true);
    expect(isPlausiblePeerFqdn(`https://${POOL_PEER_FQDN}`)).toBe(false);
    expect(isPlausiblePeerFqdn(`${POOL_PEER_FQDN}:8443`)).toBe(false);
    expect(isPlausiblePeerFqdn(`${POOL_PEER_FQDN}/api`)).toBe(false);
    expect(isPlausiblePeerFqdn('100.64.0.1')).toBe(false);
    expect(isPlausiblePeerFqdn('hub-b')).toBe(false);
  });
});

describe('runPoolCommand', () => {
  const originalIsTTY = process.stdin.isTTY;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    poolApiKey = 'device-key';
    poolApi.fetchPoolStatus.mockReset();
    poolApi.fetchPoolPeers.mockReset();
    poolApi.setPoolEnabledSetting.mockReset();
    poolApi.setPoolPeerEnabled.mockReset();
    poolApi.unpairPoolPeer.mockReset();
    // Non-TTY is the CI/agent case: the confirmation gate must refuse rather than hang on a prompt.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  const boxText = () => (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

  /**
   * The doctor runs BEFORE the device-key gate, deliberately: an unpaired node is one of the states
   * it exists to report on, so gating it would print `Hub not paired` on precisely the node the
   * operator is trying to diagnose.
   */
  it('runs the doctor on a node with no device key, instead of demanding one', async () => {
    poolApiKey = undefined;
    runPoolDoctorSection.mockReset().mockResolvedValue(doctorSection);

    await runPoolCommand(['doctor', '--check-latency']);

    expect(runPoolDoctorSection).toHaveBeenCalledTimes(1);
    const [, options] = runPoolDoctorSection.mock.calls[0] as unknown as [string, { checkLatency: boolean; cliSubcommands: readonly string[] }];
    expect(options.checkLatency).toBe(true);
    // B4 compares the Hub's routes against THIS build's commands, which only the caller can supply.
    expect(options.cliSubcommands).toContain('doctor');
    expect(boxText()).toContain('Hub Pool preflight');
    expect(boxText()).not.toContain('Hub not paired');
    expect(exitSpy).not.toHaveBeenCalled();
    poolApiKey = 'device-key';
  });

  /**
   * The doctor's worst case is minutes of bounded-but-sequential probing on precisely the broken
   * node it targets, and the box cannot be rendered until the last probe returns. Silence there
   * reads as a hang. It narrates only once the run is visibly slow — on a healthy node the whole
   * preflight is over in about a second and five progress lines would be noise.
   */
  it('narrates a slow doctor run, and stays quiet on a fast one', async () => {
    runPoolDoctorSection.mockReset();
    runPoolDoctorSection.mockImplementation(async (_envFile: unknown, options: unknown) => {
      const { onSectionDone } = options as { onSectionDone?: (line: string, elapsedMs: number) => void };
      onSectionDone?.('A  Can this node be a pool member at all? — 0.4s', 400);
      onSectionDone?.('B  Version reconciliation — 61.0s', 61_000);
      return { lines: ['Hub Pool preflight  all 13 checks passed'], issueCount: 0, failureCount: 0, remediationCommands: [] };
    });

    await runPoolCommand(['doctor']);

    const printed = boxText();
    expect(printed).toContain('B  Version reconciliation');
    expect(printed).not.toContain('A  Can this node be a pool member');
    // The report itself is still one box at the end, not a stream of half-checks.
    expect(printed).toContain('Hub Pool preflight  all 13 checks passed');
  });

  /**
   * `pool doctor` computed `issueCount` and spent it on the box colour alone — the same defect
   * `cihub doctor` carried until #1345 — so `cihub pool doctor && cihub pool pair …` carried on from
   * a node no peer can reach. The section decides which of its checks mean broken; this asserts the
   * caller acts on that rather than on "something was reported".
   */
  describe('doctor exit code', () => {
    const section = (over: { issueCount: number; failureCount: number }) => ({
      lines: ['Hub Pool preflight  1 failed'],
      remediationCommands: [] as string[],
      ...over,
    });

    it('exits 0 on a clean preflight', async () => {
      runPoolDoctorSection.mockReset().mockResolvedValue(doctorSection);
      await runPoolCommand(['doctor']);
      expect(process.exitCode).toBeUndefined();
    });

    it('fails when a check decided this node cannot be a pool member', async () => {
      runPoolDoctorSection.mockReset().mockResolvedValue(section({ issueCount: 1, failureCount: 1 }));
      await runPoolCommand(['doctor']);
      expect(process.exitCode).toBe(1);
    });

    it('does not fail on findings that are state rather than breakage', async () => {
      // A warn is what doctor exists to report, and an `unknown` — a peer-served measurement, a probe
      // that could not run — decided nothing about this node. Neither may fail the command.
      runPoolDoctorSection.mockReset().mockResolvedValue(section({ issueCount: 3, failureCount: 0 }));
      await runPoolCommand(['doctor']);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('pool ceiling', () => {
    const settingsAfter = (poolMaxPromptTokens: number | null) => ({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
      poolMaxPromptTokens,
    });
    const statusWith = (localNode: Record<string, unknown>) => ({ localNode: { nodeFqdn: null, ...localNode } });

    beforeEach(() => {
      poolApi.setPoolMaxPromptTokens.mockReset();
    });

    it('PATCHes the ceiling and reports the one now in force', async () => {
      poolApi.setPoolMaxPromptTokens.mockResolvedValue(settingsAfter(16_000));
      poolApi.fetchPoolStatus.mockResolvedValue(statusWith({ maxPromptTokens: 16_000, maxPromptTokensSetBy: 'setting' }));

      await runPoolCommand(['ceiling', '16000', '--yes']);

      expect(poolApi.setPoolMaxPromptTokens).toHaveBeenCalledWith('.env.local', 16_000);
      const text = boxText();
      expect(text).toContain('Prompt ceiling set');
      // The one misreading that matters: that a long prompt with nowhere else to go now fails.
      expect(text).toContain('It is a preference, not a limit');
    });

    it('clears it with `clear`, sending null rather than omitting the field', async () => {
      poolApi.setPoolMaxPromptTokens.mockResolvedValue(settingsAfter(null));
      poolApi.fetchPoolStatus.mockResolvedValue(statusWith({ maxPromptTokens: null, maxPromptTokensSetBy: null }));

      await runPoolCommand(['ceiling', 'clear', '--yes']);

      expect(poolApi.setPoolMaxPromptTokens).toHaveBeenCalledWith('.env.local', null);
      expect(boxText()).toContain('Prompt ceiling cleared');
    });

    it('does not report success when the .env override is what routing actually uses', async () => {
      poolApi.setPoolMaxPromptTokens.mockResolvedValue(settingsAfter(16_000));
      poolApi.fetchPoolStatus.mockResolvedValue(statusWith({ maxPromptTokens: 8_000, maxPromptTokensSetBy: 'env' }));

      await runPoolCommand(['ceiling', '16000', '--yes']);

      const text = boxText();
      expect(text).toContain('override in force');
      expect(text).toContain('HUB_POOL_MAX_PROMPT_TOKENS=8000');
      expect(text).not.toContain('Prompt ceiling set');
    });

    it('says a Hub too old to store the ceiling changed nothing, instead of trusting its 200', async () => {
      // An older Hub's PATCH schema strips the unknown field and answers with its settings as they were.
      const { poolMaxPromptTokens: _dropped, ...olderSettings } = settingsAfter(null);
      poolApi.setPoolMaxPromptTokens.mockResolvedValue(olderSettings);
      poolApi.fetchPoolStatus.mockResolvedValue(statusWith({}));

      await runPoolCommand(['ceiling', '16000', '--yes']);

      expect(boxText()).toContain('predates prompt ceilings');
    });

    it('refuses a value the Hub would reject, before sending anything', async () => {
      await expect(runPoolCommand(['ceiling', '16k', '--yes'])).rejects.toThrow('exit');

      expect(poolApi.setPoolMaxPromptTokens).not.toHaveBeenCalled();
    });

    it('refuses without --yes on a non-interactive terminal, like every other pool state change', async () => {
      await expect(runPoolCommand(['ceiling', '16000'])).rejects.toThrow('exit');

      expect(poolApi.setPoolMaxPromptTokens).not.toHaveBeenCalled();
    });
  });

  describe('pool context-cap', () => {
    const prefs = (maxNumCtx: number | null, preferredBackend: string | null = 'ollama') => ({ preferredBackend, preferredModel: null, maxNumCtx });

    beforeEach(() => {
      poolApi.fetchInferencePreferences.mockReset();
      poolApi.setInferenceContextCap.mockReset();
    });

    it('reads the preferences, PATCHes the cap with the stored backend, and reports the cap read back afterwards', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(null, 'vllm')).mockResolvedValueOnce(prefs(16_384, 'vllm'));
      poolApi.setInferenceContextCap.mockResolvedValue(prefs(16_384, 'vllm'));

      await runPoolCommand(['context-cap', '16384', '--yes']);

      expect(poolApi.setInferenceContextCap).toHaveBeenCalledWith('.env.local', 'vllm', 16_384);
      // Read before (for the backend and the current cap) and after (for the cap in force).
      expect(poolApi.fetchInferencePreferences).toHaveBeenCalledTimes(2);
      const text = boxText();
      expect(text).toContain('Context cap set');
      expect(text).toContain('at most 16384 tokens');
      // The other half of the setting, or the cap is a lie in the other direction.
      expect(text).toContain('cihub fleet backends --ollama-context 16384');
      expect(process.exitCode).toBeUndefined();
    });

    it('sends Ollama as the backend when none is stored — what the Hub resolves an absent preference to anyway', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(null, null)).mockResolvedValueOnce(prefs(16_384, 'ollama'));
      poolApi.setInferenceContextCap.mockResolvedValue(prefs(16_384, 'ollama'));

      await runPoolCommand(['context-cap', '16384', '--yes']);

      expect(poolApi.setInferenceContextCap).toHaveBeenCalledWith('.env.local', 'ollama', 16_384);
    });

    it('clears it with `clear`, sending null rather than omitting the field', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(65_536)).mockResolvedValueOnce(prefs(null));
      poolApi.setInferenceContextCap.mockResolvedValue(prefs(null));

      await runPoolCommand(['context-cap', 'clear', '--yes']);

      expect(poolApi.setInferenceContextCap).toHaveBeenCalledWith('.env.local', 'ollama', null);
      expect(boxText()).toContain('Context cap cleared');
    });

    it('writes nothing when the cap already reads as requested, because the write restarts apps', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValue(prefs(16_384));

      await runPoolCommand(['context-cap', '16384', '--yes']);
      expect(poolApi.setInferenceContextCap).not.toHaveBeenCalled();
      expect(boxText()).toContain('already 16384 tokens');

      poolApi.fetchInferencePreferences.mockResolvedValue(prefs(null));
      await runPoolCommand(['context-cap', 'clear', '--yes']);
      expect(poolApi.setInferenceContextCap).not.toHaveBeenCalled();
      expect(boxText()).toContain('nothing to clear');
      expect(process.exitCode).toBeUndefined();
    });

    it('says a Hub too old to store the cap changed nothing, and writes nothing to it', async () => {
      // An older Hub's preferences have no maxNumCtx at all; its PATCH schema would strip the field and answer 200.
      poolApi.fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', preferredModel: null });

      await runPoolCommand(['context-cap', '16384', '--yes']);

      expect(poolApi.setInferenceContextCap).not.toHaveBeenCalled();
      expect(boxText()).toContain('predates the context cap');
      expect(process.exitCode).toBe(1);
    });

    it('does not report success when the read-back disagrees with the write', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(null)).mockResolvedValueOnce(prefs(null));
      poolApi.setInferenceContextCap.mockResolvedValue(prefs(null));

      await runPoolCommand(['context-cap', '16384', '--yes']);

      const text = boxText();
      expect(text).toContain('Context cap not in force');
      expect(text).not.toContain('Context cap set');
      expect(process.exitCode).toBe(1);
    });

    it('falls back to the PATCH answer when the read-back fails, rather than losing a write that happened', async () => {
      poolApi.fetchInferencePreferences
        .mockResolvedValueOnce(prefs(null))
        .mockRejectedValueOnce(new Error('Hub API /inference/preferences failed (503)'));
      poolApi.setInferenceContextCap.mockResolvedValue(prefs(16_384));

      await runPoolCommand(['context-cap', '16384', '--yes']);

      expect(boxText()).toContain('Context cap set');
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses a value the Hub would reject, before sending anything', async () => {
      await expect(runPoolCommand(['context-cap', '16k', '--yes'])).rejects.toThrow('exit');
      await expect(runPoolCommand(['context-cap', '1024', '--yes'])).rejects.toThrow('exit');

      expect(poolApi.fetchInferencePreferences).not.toHaveBeenCalled();
      expect(poolApi.setInferenceContextCap).not.toHaveBeenCalled();
    });

    it('refuses without --yes on a non-interactive terminal, like the ceiling', async () => {
      await expect(runPoolCommand(['context-cap', '16384'])).rejects.toThrow('exit');

      expect(poolApi.setInferenceContextCap).not.toHaveBeenCalled();
    });
  });

  describe('pool slots', () => {
    const prefs = (ollamaSlots: number | null, preferredBackend: string | null = 'ollama') => ({
      preferredBackend,
      preferredModel: null,
      ollamaSlots,
    });

    beforeEach(() => {
      poolApi.fetchInferencePreferences.mockReset();
      poolApi.setInferenceOllamaSlots.mockReset();
    });

    it('reads the preferences, PATCHes the count with the stored backend, and reports the count read back afterwards', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(null, 'vllm')).mockResolvedValueOnce(prefs(4, 'vllm'));
      poolApi.setInferenceOllamaSlots.mockResolvedValue(prefs(4, 'vllm'));

      await runPoolCommand(['slots', '4', '--yes']);

      expect(poolApi.setInferenceOllamaSlots).toHaveBeenCalledWith('.env.local', 'vllm', 4);
      expect(poolApi.fetchInferencePreferences).toHaveBeenCalledTimes(2);
      const text = boxText();
      expect(text).toContain('Slot count set');
      expect(text).toContain('runs 4 requests at once');
      // The other half of the setting, or the pool places against slots that are not there.
      expect(text).toContain('cihub fleet backends --ollama-parallel 4');
      expect(process.exitCode).toBeUndefined();
    });

    it('clears it with `clear`, sending null rather than omitting the field', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValueOnce(prefs(2)).mockResolvedValueOnce(prefs(null));
      poolApi.setInferenceOllamaSlots.mockResolvedValue(prefs(null));

      await runPoolCommand(['slots', 'clear', '--yes']);

      expect(poolApi.setInferenceOllamaSlots).toHaveBeenCalledWith('.env.local', 'ollama', null);
      expect(boxText()).toContain('Slot count cleared');
    });

    it('writes nothing when the count already reads as requested', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValue(prefs(4));

      await runPoolCommand(['slots', '4', '--yes']);
      expect(poolApi.setInferenceOllamaSlots).not.toHaveBeenCalled();
      expect(boxText()).toContain('already 4');
      expect(process.exitCode).toBeUndefined();
    });

    it('says a Hub too old to store the count changed nothing, and writes nothing to it', async () => {
      poolApi.fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', preferredModel: null, maxNumCtx: null });

      await runPoolCommand(['slots', '4', '--yes']);

      expect(poolApi.setInferenceOllamaSlots).not.toHaveBeenCalled();
      expect(boxText()).toContain('predates the slot count');
      expect(process.exitCode).toBe(1);
    });

    it('refuses a value the Hub would reject, before sending anything, and refuses without --yes', async () => {
      await expect(runPoolCommand(['slots', '0', '--yes'])).rejects.toThrow('exit');
      await expect(runPoolCommand(['slots', '65', '--yes'])).rejects.toThrow('exit');
      await expect(runPoolCommand(['slots', '4'])).rejects.toThrow('exit');

      expect(poolApi.fetchInferencePreferences).not.toHaveBeenCalled();
      expect(poolApi.setInferenceOllamaSlots).not.toHaveBeenCalled();
    });
  });

  it('refuses a state change without --yes on a non-interactive terminal', async () => {
    poolApi.fetchPoolPeers.mockResolvedValue([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nodeFqdn: POOL_PEER_FQDN,
        direction: 'outbound',
        status: 'connected',
        consecutiveFailures: 0,
        lastSeenAt: null,
        lastCapabilities: null,
        displayName: null,
      },
    ]);

    await expect(runPoolCommand(['unpair', POOL_PEER_FQDN])).rejects.toThrow('exit');

    expect(poolApi.unpairPoolPeer).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stripAnsi(String(errorSpy.mock.calls[0]?.[0]))).toContain('requires an interactive terminal, --yes, or CI_HUB_ASSUME_YES=1');
  });

  it('unpairs the peer resolved from an id prefix once --yes is given', async () => {
    poolApi.fetchPoolPeers.mockResolvedValue([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nodeFqdn: POOL_PEER_FQDN,
        direction: 'outbound',
        status: 'connected',
        consecutiveFailures: 0,
        lastSeenAt: null,
        lastCapabilities: null,
        displayName: null,
      },
    ]);

    await runPoolCommand(['unpair', 'aaaaaaaa', '--yes']);

    expect(poolApi.unpairPoolPeer).toHaveBeenCalledWith('.env.local', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(boxText()).toContain('Peer unpaired');
  });

  it('takes one peer out of the pool without revoking anything, and says so', async () => {
    poolApi.fetchPoolPeers.mockResolvedValue([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nodeFqdn: POOL_PEER_FQDN,
        direction: 'outbound',
        status: 'connected',
        enabled: true,
        consecutiveFailures: 0,
        lastSeenAt: null,
        lastCapabilities: null,
        displayName: null,
      },
    ]);

    await runPoolCommand(['peer-disable', 'aaaaaaaa', '--yes']);

    expect(poolApi.setPoolPeerEnabled).toHaveBeenCalledWith('.env.local', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', false);
    // The copy must not blur disable and unpair: one is reversible, the other revokes both tokens.
    const text = boxText();
    expect(text).toContain('Peer disabled');
    expect(text).toContain('NOT a revocation');
    expect(poolApi.unpairPoolPeer).not.toHaveBeenCalled();
  });

  it('says plainly that the .env override wins when enabling under HUB_POOL_USER_DISABLED', async () => {
    poolApi.fetchPoolStatus.mockResolvedValue({
      enabled: false,
      disabledBy: 'env',
      reason: 'disabled_by_env',
      routingActive: false,
      directions: { outbound: { enabled: false, disabledBy: 'env' }, inbound: { enabled: false, disabledBy: 'env' } },
      settings: { poolEnabled: false, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
    });
    poolApi.setPoolEnabledSetting.mockResolvedValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
    });

    await runPoolCommand(['enable', '--yes']);

    expect(poolApi.setPoolEnabledSetting).toHaveBeenCalledWith('.env.local', true, 'both');
    const text = boxText();
    expect(text).toContain('this changed nothing in effect');
    expect(text).toContain('HUB_POOL_USER_DISABLED=true');
    expect(text).toContain('cihub restart local');
  });

  it('sends only the named direction, so `pool disable --outbound` keeps this Hub serving', async () => {
    poolApi.fetchPoolStatus.mockResolvedValue({
      enabled: true,
      disabledBy: null,
      directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
      reason: 'active',
      routingActive: true,
      settings: { poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
    });
    poolApi.setPoolEnabledSetting.mockResolvedValue({
      poolEnabled: true,
      poolOutboundEnabled: false,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
    });

    await runPoolCommand(['disable', '--outbound', '--yes']);

    expect(poolApi.setPoolEnabledSetting).toHaveBeenCalledWith('.env.local', false, 'outbound');
    const text = boxText();
    expect(text).toContain('peers may still send work here');
  });

  it('refuses to claim success for one direction its own .env variable already forces off', async () => {
    poolApi.fetchPoolStatus.mockResolvedValue({
      enabled: true,
      disabledBy: null,
      directions: { outbound: { enabled: false, disabledBy: 'env' }, inbound: { enabled: true, disabledBy: null } },
      reason: 'partially_disabled',
      routingActive: false,
      settings: { poolEnabled: true, poolOutboundEnabled: false, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
    });
    poolApi.setPoolEnabledSetting.mockResolvedValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
    });

    await runPoolCommand(['enable', '--outbound', '--yes']);

    const text = boxText();
    expect(text).toContain('this changed nothing in effect');
    expect(text).toContain('HUB_POOL_OUTBOUND_DISABLED=true');
    // Not the master variable: that one is not what has to change here.
    expect(text).not.toContain('HUB_POOL_USER_DISABLED=true');
  });

  it('reports an enable that actually takes effect without the override warning', async () => {
    poolApi.fetchPoolStatus.mockResolvedValue({
      enabled: false,
      disabledBy: 'setting',
      reason: 'disabled_by_setting',
      routingActive: false,
      directions: { outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: false, disabledBy: 'setting' } },
      settings: { poolEnabled: false, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
    });
    poolApi.setPoolEnabledSetting.mockResolvedValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
    });

    await runPoolCommand(['enable', '--yes']);

    const text = boxText();
    expect(text).toContain('Hub Pool enabled');
    expect(text).not.toContain('changed nothing in effect');
  });

  it('points an unpaired Hub at cihub register instead of a raw 401', async () => {
    poolApiKey = undefined;

    await expect(runPoolCommand(['status'])).rejects.toThrow('exit');

    expect(poolApi.fetchPoolStatus).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(boxText()).toContain('cihub register');
  });
});
