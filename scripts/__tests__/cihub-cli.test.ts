import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCliArgs, renderHelp, renderWizardWelcome, resolveWizardActionInput, resolveWizardEnvInput, stripAnsi } from '../cihub-cli';

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
  });
});

describe('wizard selections', () => {
  it('accepts numeric shortcuts for environments and actions', () => {
    expect(resolveWizardEnvInput('4')).toBe('prod');
    expect(resolveWizardActionInput('5')).toBe('mcp-setup');
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
