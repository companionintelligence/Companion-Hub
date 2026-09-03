import { describe, expect, it } from 'vitest';
import { didPublicRoutingIdentityChange, publishesCloudflarePublicRoute, resolveRoutingSubdomain } from '../app-public-routing.helpers';

describe('app-public-routing.helpers', () => {
  describe('publishesCloudflarePublicRoute', () => {
    it('returns true for cloudflare exposure mode', () => {
      expect(publishesCloudflarePublicRoute({ exposureMode: 'cloudflare', exposedLocal: false })).toBe(true);
    });

    it('returns true for legacy exposedLocal apps', () => {
      expect(publishesCloudflarePublicRoute({ exposedLocal: true })).toBe(true);
    });

    it('returns false for local-only apps', () => {
      expect(publishesCloudflarePublicRoute({ exposureMode: 'local', exposedLocal: false })).toBe(false);
    });
  });

  describe('resolveRoutingSubdomain', () => {
    it('falls back to appName-storeSlug when localSubdomain is empty', () => {
      expect(resolveRoutingSubdomain(null, 'myapp', 'ci-marketplace')).toBe('myapp-ci-marketplace');
    });
  });

  describe('didPublicRoutingIdentityChange', () => {
    const appName = 'airtrail';
    const appStoreSlug = 'ci-marketplace';

    it('detects subdomain changes for cloudflare apps', () => {
      expect(
        didPublicRoutingIdentityChange(
          { exposureMode: 'cloudflare', localSubdomain: 'airtrail-old' },
          { exposureMode: 'cloudflare', localSubdomain: 'airtrail-new' },
          appName,
          appStoreSlug,
        ),
      ).toBe(true);
    });

    it('detects public domain changes when the subdomain stays the same', () => {
      expect(
        didPublicRoutingIdentityChange(
          { exposureMode: 'cloudflare', localSubdomain: 'airtrail', publicDomain: 'example.com' },
          { exposureMode: 'cloudflare', localSubdomain: 'airtrail', publicDomain: 'other.com' },
          appName,
          appStoreSlug,
        ),
      ).toBe(true);
    });

    it('returns false when local-only settings change unrelated fields', () => {
      expect(
        didPublicRoutingIdentityChange({ exposureMode: 'local', openPort: true }, { exposureMode: 'local', openPort: false }, appName, appStoreSlug),
      ).toBe(false);
    });

    it('returns true when cloudflare exposure is disabled', () => {
      expect(
        didPublicRoutingIdentityChange(
          { exposureMode: 'cloudflare', localSubdomain: 'airtrail' },
          { exposureMode: 'local', exposedLocal: false, localSubdomain: 'airtrail' },
          appName,
          appStoreSlug,
        ),
      ).toBe(true);
    });
  });
});
