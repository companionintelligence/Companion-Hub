/**
 * The parsing and comparison helpers of `scripts/release-check.mjs`. The lookups themselves talk to GitHub,
 * GHCR, Google Play and the App Store, so they are exercised by running the script, not here.
 */
import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  formatMarkdown,
  hubVersionOnDownloadPage,
  INSTALLERS,
  isReleaseVersion,
  maxVersion,
  missingFiles,
  normalizeVersion,
  parseCaskVersion,
  parseCiOsHubPin,
  tauriVersionFromCode,
  versionStatus,
} from '../release-check.mjs';

describe('release-check versions', () => {
  it('strips the v and compares numbers, not text', () => {
    expect(normalizeVersion('v0.3.13')).toBe('0.3.13');
    expect(normalizeVersion(null)).toBeNull();
    expect(compareVersions('0.3.13', '0.3.9')).toBe(1);
    expect(compareVersions('v0.3.13', '0.3.13')).toBe(0);
  });

  it('marks each row by how the found version compares', () => {
    expect(versionStatus('0.3.13', '0.3.13')).toBe('OK');
    expect(versionStatus('0.3.13', '0.3.11')).toBe('BEHIND');
    expect(versionStatus('0.3.13', '0.3.14')).toBe('AHEAD');
    expect(versionStatus('0.3.13', '')).toBe('MISSING');
  });

  it('ignores names that are not versions', () => {
    expect(isReleaseVersion('Companion Hub')).toBe(false);
    expect(maxVersion(['latest', '0.3.11', '0.3.13-rc1', '0.3.12'])).toBe('0.3.12');
  });

  it('decodes Tauri Android build numbers', () => {
    expect(tauriVersionFromCode(1002)).toBe('0.1.2');
    expect(tauriVersionFromCode(3014)).toBe('0.3.14');
    expect(tauriVersionFromCode('x')).toBeNull();
  });
});

describe('release-check parsers', () => {
  it('reports the installer files a platform lacks for this version', () => {
    const assets = ['Companion.Hub_0.3.13_aarch64.dmg', 'Companion.Hub_0.3.12_x64.dmg'];
    const patterns = (label: string) => INSTALLERS.find(([name]) => name === label)?.[1] as string[];
    expect(missingFiles(assets, patterns('macOS Apple Silicon'), '0.3.13')).toEqual([]);
    expect(missingFiles(assets, patterns('macOS Intel'), '0.3.13')).toEqual(['_0.3.13_x64.dmg']);
  });

  it('reads the cask version, the CI-OS pin and the download page', () => {
    expect(parseCaskVersion('cask "companion-hub" do\n  version "0.3.13"\n')).toBe('0.3.13');
    const env = [
      '# LAUNCHER_URL=https://dl.ci.computer/v9.9.9/',
      'LAUNCHER_URL=https://dl.ci.computer/v0.3.11/linux/deb/x64/Companion%20Hub_0.3.11_amd64.deb',
      'LAUNCHER_URL_ARM64=https://dl.ci.computer/v0.3.10/linux/deb/arm/x.deb',
    ].join('\n');
    expect(parseCiOsHubPin(env)).toBe('0.3.11');
    const html = '<a href="https://dl.ci.computer/v0.3.11/macos/arm/a.dmg"><a href="https://dl.ci.computer/applet/v0.2.0-alpha.9/x">';
    expect(hubVersionOnDownloadPage(html)).toBe('0.3.11');
  });

  it('bolds failing statuses and escapes pipes in markdown', () => {
    const md = formatMarkdown([{ where: 'a|b', expected: '1', found: '0', status: 'BEHIND', note: '' }]);
    expect(md).toMatch(/\| a\\\|b \| 1 \| 0 \| \*\*BEHIND\*\* \|/);
  });
});
