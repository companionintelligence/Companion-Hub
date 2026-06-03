import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appStatusColor,
  box,
  buildEnvOverrides,
  getComposeFiles,
  isFirstRun,
  isHubRepoRoot,
  mergeComposeProfilesFromEnvFile,
  normalizeCliArgs,
  parseAppRuntimeArgs,
  parseEnvFile,
  renderBanner,
  renderHelp,
  renderManPage,
  renderStep,
  renderVersion,
  renderWizardWelcome,
  resolveEnvFromArgs,
  resolveWizardActionInput,
  resolveWizardEnvInput,
  stripAnsi,
  upsertEnvVar,
} from '../cihub-cli';

// ??? banner ???????????????????????????????????????????????????????????????????

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
    expect(plain).toContain('Developer workflow');
  });

  it('mentions the new app subcommands', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('app status');
    expect(plain).toContain('app logs');
    expect(plain).toContain('app inspect');
  });

  it('lists the Models section with install/rm', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('Models');
    expect(plain).toContain('models list');
    expect(plain).toContain('models install');
    expect(plain).toContain('models rm');
  });

  it('shows the cihub status command', () => {
    const plain = stripAnsi(renderHelp());
    expect(plain).toContain('cihub status');
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

  it('mentions pnpm run hub compat command', () => {
    const plain = stripAnsi(renderManPage());
    expect(plain).toContain('pnpm run hub -- <command> [args]');
  });
});

// ??? step renderer ????????????????????????????????????????????????????????????

describe('renderStep', () => {
  it('shows counter and label', () => {
    const plain = stripAnsi(renderStep(2, 4, 'Installing dependencies'));
    expect(plain).toContain('[2/4]');
    expect(plain).toContain('Installing dependencies');
  });

  it('uses the right icon for each status', () => {
    expect(stripAnsi(renderStep(1, 3, 'x', 'pending'))).toContain('?');
    expect(stripAnsi(renderStep(1, 3, 'x', 'active'))).toContain('?');
    expect(stripAnsi(renderStep(1, 3, 'x', 'done'))).toContain('?');
    expect(stripAnsi(renderStep(1, 3, 'x', 'fail'))).toContain('?');
  });
});

// ??? version ?????????????????????????????????????????????????????????????????

describe('renderVersion', () => {
  it('includes the cihub command name', () => {
    expect(renderVersion()).toContain('cihub');
  });

  it('reads version from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    if (pkg.version) {
      expect(renderVersion()).toContain(pkg.version);
    }
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

// ??? arg helpers ?????????????????????????????????????????????????????????????

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

// ??? wizard selections ????????????????????????????????????????????????????????

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
    expect(resolveWizardActionInput('9')).toBe('purge');
    expect(resolveWizardActionInput('10')).toBe('hot-reload');
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

// ??? stripAnsi ??????????????????????????????????????????????????????????????????

describe('stripAnsi', () => {
  it('removes SGR colour and style codes', () => {
    expect(stripAnsi('[32mgreen[0m')).toBe('green');
    expect(stripAnsi('[1m[36mbold cyan[0m')).toBe('bold cyan');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no codes here')).toBe('no codes here');
  });
});

// ??? compose file mapping ??????????????????????????????????????????????????????

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

// ??? app runtime arg parsing ????????????????????????????????????????????????????

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

// ??? status colour coding ???????????????????????????????????????????????????????

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

// ??? box rendering primitive ????????????????????????????????????????????????????

describe('box', () => {
  it('renders a title header, indented body, and a closing rule', () => {
    const lines = stripAnsi(box('Title', ['line one', 'line two'])).split('\n');
    expect(lines[0]).toContain('?? Title');
    expect(lines[0]).toContain('?');
    expect(lines[1]).toBe('  line one');
    expect(lines[2]).toBe('  line two');
    expect(lines[lines.length - 1]).toContain('?');
    expect(lines[lines.length - 1]).toContain('?');
  });

  it('handles an empty body without throwing', () => {
    expect(() => box('Empty', [])).not.toThrow();
  });
});

// ??? package metadata ?????????????????????????????????????????????????????????

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
