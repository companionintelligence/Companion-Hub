import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeCliArgs,
  renderHelp,
  renderManPage,
  renderWizardWelcome,
  resolveEnvFromArgs,
  resolveWizardActionInput,
  resolveWizardEnvInput,
  stripAnsi,
} from '../cihub-cli';

describe('cihub CLI presentation', () => {
  it('strips the forwarded npm double dash', () => {
    expect(normalizeCliArgs(['--', '--help'])).toEqual(['--help']);
  });

  it('renders the wizard banner with the companion intelligence art', () => {
    process.env.FORCE_COLOR = '1';
    const output = renderWizardWelcome();
    expect(output).toContain('\u001b[32m');
    expect(stripAnsi(output)).toContain('__   __         __               __');
    expect(stripAnsi(output)).toContain('___  ___              __   ___');
    delete process.env.FORCE_COLOR;
  });

  it('renders help with the publishable cihub executable', () => {
    const output = stripAnsi(renderHelp());
    expect(output).toContain('cihub wizard');
    expect(output).toContain('npm install -g ci-hub');
    expect(output).toContain('npx --package ci-hub cihub --help');
    expect(output).toContain('__   __         __               __');
    expect(output).toContain('Quick start');
    expect(output).toContain('Developer workflow');
    expect(output).toContain('cihub purge [--yes]');
    expect(output).toContain('cihub hot-reload [env]');
    expect(output).toContain('Container app lifecycle');
  });

  it('renders the man page with synopsis and packaging guidance', () => {
    const output = stripAnsi(renderManPage());
    expect(output).toContain('CIHUB(1)');
    expect(output).toContain('Synopsis');
    expect(output).toContain('pnpm run hub -- <command> [args]');
    expect(output).toContain('Packaging');
    expect(output).toContain('developer purge/hot-reload flows');
    expect(output).toContain('Homebrew and other package managers should install the same cihub executable.');
  });
});

describe('wizard selections', () => {
  it('accepts numeric shortcuts for environments and actions', () => {
    expect(resolveWizardEnvInput('4')).toBe('prod');
    expect(resolveWizardActionInput('5')).toBe('mcp-setup');
    expect(resolveWizardActionInput('9')).toBe('purge');
    expect(resolveWizardActionInput('10')).toBe('hot-reload');
  });
});

describe('resolveEnvFromArgs', () => {
  it('returns local by default when no args', () => {
    expect(resolveEnvFromArgs([])).toBe('local');
  });

  it('picks the named env from the arg list', () => {
    expect(resolveEnvFromArgs(['staging'])).toBe('staging');
    expect(resolveEnvFromArgs(['prod'])).toBe('prod');
  });

  it('rejects unrecognised arguments so typos are caught', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveEnvFromArgs(['lokl'])).toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('package metadata', () => {
  it('publishes the cihub executable', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin?.cihub).toBe('./bin/cihub.cjs');
  });
});
