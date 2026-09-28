import { describe, expect, it } from 'vitest';
import {
  didPublicRoutingIdentityChange,
  publishesCloudflarePublicRoute,
  requiresHubLoginOnPublicRoute,
  resolveRoutingSubdomain,
} from '../app-public-routing.helpers';

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

  describe('requiresHubLoginOnPublicRoute', () => {
    const edgeAuthOn = { exposable: true, hub_integration: { edge_auth: { default: true } } };

    it('honours an explicit operator choice over the manifest and the port', () => {
      expect(requiresHubLoginOnPublicRoute({ enableAuth: false, openPort: true }, edgeAuthOn)).toBe(false);
      expect(requiresHubLoginOnPublicRoute({ enableAuth: true, openPort: false })).toBe(true);
    });

    it('falls back to the manifest edge-auth default for a stored form that never decided', () => {
      // The 2026-09-28 OpenClaw shape: openPort false, no enableAuth key. The route must carry the
      // login as soon as the manifest asks for it, without waiting for a settings re-save.
      expect(requiresHubLoginOnPublicRoute({ openPort: false }, edgeAuthOn)).toBe(true);
      expect(requiresHubLoginOnPublicRoute({ openPort: false }, { exposable: true })).toBe(false);
      // A manifest default only counts for an exposable app.
      expect(requiresHubLoginOnPublicRoute({ openPort: false }, { exposable: false, hub_integration: { edge_auth: { default: true } } })).toBe(false);
    });

    it('turns the login on for an open host port when neither the form nor a manifest decided', () => {
      expect(requiresHubLoginOnPublicRoute({ openPort: true })).toBe(true);
      expect(requiresHubLoginOnPublicRoute({ openPort: false })).toBe(false);
      expect(requiresHubLoginOnPublicRoute({})).toBe(false);
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
