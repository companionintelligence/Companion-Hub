import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isFirstRun,
  normalizeCliArgs,
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
} from '../cihub-cli';

// ─── banner ───────────────────────────────────────────────────────────────────

describe('banner', () => {
  it('contains the Companion Intelligence ASCII art (slant/small style)', () => {
    const plain = stripAnsi(renderBanner());
    expect(plain).toContain('/ __|___ _ __  _ __  __ _ _ _ (_)___ _ _');
    expect(plain).toContain('|_ _|_ _| |_ ___| | (_)__ _ ___ _ _  __ ___');
  });

  it('shows the company tagline', () => {
    const plain = stripAnsi(renderBanner());
    expect(plain).toContain('companionintelligence.com');
  });

  it('renders ANSI green colour when FORCE_COLOR is set', () => {
    process.env.FORCE_COLOR = '1';
    const art = renderBanner();
    expect(art).toContain('[32m');
    delete process.env.FORCE_COLOR;
  });

  it('wizard welcome embeds the banner', () => {
    const plain = stripAnsi(renderWizardWelcome());
    expect(plain).toContain('/ __|___ _ __');
    expect(plain).toContain('Setup Wizard');
    expect(plain).toContain('cihub man');
  });
});

// ─── help & man ───────────────────────────────────────────────────────────────

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

// ─── step renderer ────────────────────────────────────────────────────────────

describe('renderStep', () => {
  it('shows counter and label', () => {
    const plain = stripAnsi(renderStep(2, 4, 'Installing dependencies'));
    expect(plain).toContain('[2/4]');
    expect(plain).toContain('Installing dependencies');
  });

  it('uses the right icon for each status', () => {
    expect(stripAnsi(renderStep(1, 3, 'x', 'pending'))).toContain('○');
    expect(stripAnsi(renderStep(1, 3, 'x', 'active'))).toContain('●');
    expect(stripAnsi(renderStep(1, 3, 'x', 'done'))).toContain('✓');
    expect(stripAnsi(renderStep(1, 3, 'x', 'fail'))).toContain('✗');
  });
});

// ─── version ─────────────────────────────────────────────────────────────────

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

// ─── first-run detection ──────────────────────────────────────────────────────

describe('isFirstRun', () => {
  it('returns true when the env file does not exist', () => {
    expect(isFirstRun('__no_such_env_file_xyz__.local')).toBe(true);
  });

  it('returns false when the env file exists', () => {
    const found = existsSync(join(process.cwd(), '.env.local'));
    expect(isFirstRun('.env.local')).toBe(!found);
  });
});

// ─── arg helpers ─────────────────────────────────────────────────────────────

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

// ─── wizard selections ────────────────────────────────────────────────────────

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
});

// ─── package metadata ─────────────────────────────────────────────────────────

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
