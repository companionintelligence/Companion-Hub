import { describe, expect, it } from 'vitest';

import {
  type DesktopReleaseManifest,
  desktopInstallerUrl,
  desktopReleaseCdn,
  isTrustedDownloadUrlForHost,
  platformManifestKey,
} from '../desktop-release';

const artifact = (path: string) => ({ url: `https://dl.ci.computer/v0.2.77/${path}`, size: 1 });

const manifest: DesktopReleaseManifest = {
  version: '0.2.77',
  platforms: {
    'darwin-aarch64': { dmg: artifact('macos/arm/Companion%20Hub_0.2.77_aarch64.dmg') },
    'windows-x86_64': {
      msi: artifact('windows/x64/Companion%20Hub_0.2.77_x64_en-US.msi'),
      exe: artifact('windows/x64/Companion%20Hub_0.2.77_x64-setup.exe'),
    },
    'windows-aarch64': { msi: artifact('windows/arm64/Companion%20Hub_0.2.77_arm64_en-US.msi') },
    'linux-x86_64': {
      deb: artifact('linux/deb/x64/Companion%20Hub_0.2.77_amd64.deb'),
      rpm: artifact('linux/rpm/x64/Companion%20Hub-0.2.77-1.x86_64.rpm'),
    },
    'linux-aarch64': {
      rpm: artifact('linux/rpm/arm/Companion%20Hub-0.2.77-1.aarch64.rpm'),
      appimage: artifact('linux/appimage/arm/Companion%20Hub_0.2.77_aarch64.AppImage'),
    },
  },
};

describe('desktopReleaseCdn', () => {
  it('reads the production download server for a production build', () => {
    expect(desktopReleaseCdn('production')).toEqual({ base: 'https://dl.ci.computer', host: 'dl.ci.computer' });
  });

  it.each(['dev', 'staging', '', undefined, 'Production', 'https://evil.example.com'])('reads the dev download server for %j', (environment) => {
    expect(desktopReleaseCdn(environment)).toEqual({ base: 'https://dl-dev.ci.computer', host: 'dl-dev.ci.computer' });
  });
});

describe('platformManifestKey', () => {
  it('maps all release-matrix platform/arch pairs', () => {
    expect(platformManifestKey('macos', 'aarch64')).toBe('darwin-aarch64');
    expect(platformManifestKey('macos', 'x86_64')).toBe('darwin-x86_64');
    expect(platformManifestKey('windows', 'aarch64')).toBe('windows-aarch64');
    expect(platformManifestKey('windows', 'x86_64')).toBe('windows-x86_64');
    expect(platformManifestKey('linux', 'aarch64')).toBe('linux-aarch64');
    expect(platformManifestKey('linux', 'x86_64')).toBe('linux-x86_64');
  });

  it('returns null for unknown platforms', () => {
    expect(platformManifestKey('freebsd', 'x86_64')).toBeNull();
  });
});

describe('desktopInstallerUrl', () => {
  it('picks the dmg on macOS', () => {
    expect(desktopInstallerUrl(manifest, 'macos', 'aarch64')).toBe(artifact('macos/arm/Companion%20Hub_0.2.77_aarch64.dmg').url);
  });

  it('prefers the setup exe to the msi on Windows', () => {
    expect(desktopInstallerUrl(manifest, 'windows', 'x86_64')).toBe(artifact('windows/x64/Companion%20Hub_0.2.77_x64-setup.exe').url);
    expect(desktopInstallerUrl(manifest, 'windows', 'aarch64')).toBe(artifact('windows/arm64/Companion%20Hub_0.2.77_arm64_en-US.msi').url);
  });

  it('prefers an AppImage, then a deb, then an rpm on Linux', () => {
    expect(desktopInstallerUrl(manifest, 'linux', 'aarch64')).toBe(artifact('linux/appimage/arm/Companion%20Hub_0.2.77_aarch64.AppImage').url);
    expect(desktopInstallerUrl(manifest, 'linux', 'x86_64')).toBe(artifact('linux/deb/x64/Companion%20Hub_0.2.77_amd64.deb').url);
  });

  it('returns null when the release has no build for the platform or architecture', () => {
    expect(desktopInstallerUrl(manifest, 'macos', 'x86_64')).toBeNull();
    expect(desktopInstallerUrl(manifest, 'freebsd', 'x86_64')).toBeNull();
  });
});

describe('isTrustedDownloadUrlForHost', () => {
  it('accepts only HTTPS downloads from the given host', () => {
    const url = 'https://dl-dev.ci.computer/v0.2.61/macos/arm/Companion%20Hub_0.2.61_aarch64.dmg';
    expect(isTrustedDownloadUrlForHost(url, 'dl-dev.ci.computer')).toBe(true);
    expect(isTrustedDownloadUrlForHost(url, 'dl.ci.computer')).toBe(false);
    expect(isTrustedDownloadUrlForHost(url.replace('https:', 'http:'), 'dl-dev.ci.computer')).toBe(false);
  });

  it('rejects parent-directory segments, encoded or not', () => {
    expect(isTrustedDownloadUrlForHost('https://dl.ci.computer/v0.2.77/../evil.dmg', 'dl.ci.computer')).toBe(false);
    expect(isTrustedDownloadUrlForHost('https://dl.ci.computer/v0.2.77/%252e%252e/evil.dmg', 'dl.ci.computer')).toBe(false);
  });
});
