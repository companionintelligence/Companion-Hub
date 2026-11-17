import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectServiceSecurityViolations, TRUSTED_APP_SECURITY_ALLOWLIST } from '@ci-hub/common/schemas';
import { hubProtectedHostPaths, securityGrantsFor } from '../security-grants';

const bind = (hostPath: string) => ({ volumes: [{ hostPath, containerPath: '/x' }] });
const deniedFor = (urn: string, hostPath: string, author?: 'operator') =>
  collectServiceSecurityViolations(bind(hostPath), securityGrantsFor(urn, author ? { author } : {})).length > 0;

describe('securityGrantsFor', () => {
  const saved = { root: process.env.ROOT_FOLDER_HOST, appData: process.env.CI_HUB_APP_DATA_PATH };

  beforeEach(() => {
    process.env.ROOT_FOLDER_HOST = '/opt/companion-hub/data';
    delete process.env.CI_HUB_APP_DATA_PATH;
  });

  afterEach(() => {
    process.env.ROOT_FOLDER_HOST = saved.root;
    if (saved.appData === undefined) delete process.env.CI_HUB_APP_DATA_PATH;
    else process.env.CI_HUB_APP_DATA_PATH = saved.appData;
  });

  it('hands an official store app the grant the allowlist names for it', () => {
    expect(securityGrantsFor('falco:ci-marketplace')).toMatchObject(TRUSTED_APP_SECURITY_ALLOWLIST.falco as object);
  });

  it('gives a user-added store that reuses an allowlisted name no grant', () => {
    const grants = securityGrantsFor('falco:my-own-store');
    expect(grants.hostPaths).toBeUndefined();
    expect(grants.privileged).toBeUndefined();
  });

  it('gives an official app with no allowlist entry no grant', () => {
    expect(securityGrantsFor('dozzle:ci-marketplace').hostPaths).toBeUndefined();
  });

  it('gives a malformed URN no grant and the listing rule', () => {
    expect(securityGrantsFor('falco')).toMatchObject({ hostBindAuthor: 'listing' });
    expect(securityGrantsFor('falco').hostPaths).toBeUndefined();
  });

  it('takes the author from install provenance', () => {
    expect(securityGrantsFor('jellyfin:ci-marketplace').hostBindAuthor).toBe('listing');
    expect(securityGrantsFor('jellyfin:some-store').hostBindAuthor).toBe('listing');
    expect(securityGrantsFor('my-app:_user').hostBindAuthor).toBe('operator');
    expect(securityGrantsFor('jellyfin:ci-marketplace', { author: 'operator' }).hostBindAuthor).toBe('operator');
  });

  it('returns the same object for the same context, so the parse schema cache keeps hitting', () => {
    expect(securityGrantsFor('a:some-store')).toBe(securityGrantsFor('b:other-store'));
  });

  describe('a store listing (any store) binds only its own data folder', () => {
    it.each(['${APP_DATA_DIR}', '${APP_DATA_DIR}/config', '${APP_DATA_DIR}/.cache', '/etc/localtime'])('allows %s', (hostPath) => {
      expect(deniedFor('jellyfin:some-store', hostPath)).toBe(false);
    });

    it.each([
      '/home',
      '/home/kyle/Music',
      '/data',
      '/data/companion-hub',
      '/opt',
      '/srv',
      '/mnt/media',
      '/media',
      '/tmp',
      '/Users',
      '/opt/companion-hub/data/app-data/ci-marketplace/ci-memory',
    ])('refuses %s', (hostPath) => {
      expect(deniedFor('jellyfin:some-store', hostPath)).toBe(true);
    });

    it('still honours an audited grant', () => {
      expect(deniedFor('netdata:ci-marketplace', '/proc')).toBe(false);
      expect(deniedFor('netdata:some-store', '/proc')).toBe(true);
    });
  });

  describe('a custom app or override, written on this Hub', () => {
    it.each(['/mnt/media', '/media/usb', '/srv/music', '/home/kyle/Music', '/Users/kyle/Pictures', '/opt/other', '${APP_DATA_DIR}/.cache'])(
      'allows %s',
      (hostPath) => {
        expect(deniedFor('my-app:_user', hostPath)).toBe(false);
        expect(deniedFor('jellyfin:ci-marketplace', hostPath, 'operator')).toBe(false);
      },
    );

    it.each([
      ['the Hub data root', '/opt/companion-hub/data'],
      ['another app’s data', '/opt/companion-hub/data/app-data/ci-marketplace/ci-memory'],
      ['the install folder (.env, tunnel)', '/opt/companion-hub'],
      ['an ancestor of the Hub', '/opt'],
      ['the home root', '/home'],
      ['a home folder itself', '/home/kyle'],
      ['a macOS home folder', '/Users/kyle'],
      ['ssh keys', '/home/kyle/.ssh'],
      ['a hidden folder anywhere', '/mnt/media/.config'],
      ['snap Docker data', '/var/snap/docker/common/var-lib-docker'],
      ['/snap', '/snap'],
    ])('refuses %s', (_label, hostPath) => {
      expect(deniedFor('my-app:_user', hostPath)).toBe(true);
      expect(deniedFor('jellyfin:ci-marketplace', hostPath, 'operator')).toBe(true);
    });
  });
});

describe('hubProtectedHostPaths', () => {
  it('protects the data root and the install folder that holds it', () => {
    expect(hubProtectedHostPaths({ ROOT_FOLDER_HOST: '/home/kyle/ci-hub/.internal' })).toEqual(
      expect.arrayContaining(['/home/kyle/ci-hub/.internal', '/home/kyle/ci-hub', '/home/kyle/ci-hub/.internal/app-data']),
    );
  });

  it('protects a relocated app-data root', () => {
    expect(hubProtectedHostPaths({ ROOT_FOLDER_HOST: '/opt/hub/data', CI_HUB_APP_DATA_PATH: '/mnt/big/hub' })).toContain('/mnt/big/hub/app-data');
  });

  it('protects nothing extra when the root is unset or relative', () => {
    expect(hubProtectedHostPaths({})).toEqual([]);
    expect(hubProtectedHostPaths({ ROOT_FOLDER_HOST: '.internal' })).toEqual([]);
  });
});
