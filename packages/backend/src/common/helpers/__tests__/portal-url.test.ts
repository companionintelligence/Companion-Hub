import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortalAxiosConfig,
  isLoopbackPortalHost,
  needsDockerHostBridge,
  resolveOutboundPortalBaseUrl,
  resolvePortalTlsServername,
  withPortalAxiosHeaders,
} from '../portal-url';

describe('portal-url', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isLoopbackPortalHost', () => {
    it('recognizes localhost-style hosts', () => {
      expect(isLoopbackPortalHost('localhost')).toBe(true);
      expect(isLoopbackPortalHost('127.0.0.1')).toBe(true);
      expect(isLoopbackPortalHost('ci-portal.localhost')).toBe(true);
      expect(isLoopbackPortalHost('hub.ci.computer')).toBe(false);
    });
  });

  describe('resolveOutboundPortalBaseUrl', () => {
    it('returns CI_PORTAL_INTERNAL_URL override when set', () => {
      expect(resolveOutboundPortalBaseUrl('https://ci-portal.localhost', 'http://host.docker.internal:8415')).toBe(
        'http://host.docker.internal:8415',
      );
    });

    it('passes through public portal URLs unchanged', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      expect(resolveOutboundPortalBaseUrl('https://hub.ci.computer')).toBe('https://hub.ci.computer');
    });

    it('bridges loopback portal URLs from Docker to host.docker.internal', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      expect(resolveOutboundPortalBaseUrl('https://ci-portal.localhost')).toBe('https://host.docker.internal');
      expect(resolveOutboundPortalBaseUrl('http://localhost:8012')).toBe('http://host.docker.internal:8012');
    });

    it('does not bridge loopback URLs when not in Docker', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(resolveOutboundPortalBaseUrl('https://ci-portal.localhost')).toBe('https://ci-portal.localhost');
    });
  });

  describe('needsDockerHostBridge', () => {
    it('is true only for Docker + loopback public URL without override', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      expect(needsDockerHostBridge('https://ci-portal.localhost')).toBe(true);
      expect(needsDockerHostBridge('https://ci-portal.localhost', 'http://host.docker.internal:8415')).toBe(false);
      expect(needsDockerHostBridge('https://hub.ci.computer')).toBe(false);
    });
  });

  describe('resolvePortalTlsServername', () => {
    it('returns the public hostname for loopback portal URLs', () => {
      expect(resolvePortalTlsServername('https://ci-portal.localhost')).toBe('ci-portal.localhost');
      expect(resolvePortalTlsServername('https://hub.ci.computer')).toBeUndefined();
    });
  });

  describe('buildPortalAxiosConfig', () => {
    it('preserves the public Host header when bridging through host.docker.internal', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const config = buildPortalAxiosConfig('https://ci-portal.localhost');

      expect(config.headers).toMatchObject({ Host: 'ci-portal.localhost' });
    });

    it('does not set Host when an explicit internal override is used', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const config = buildPortalAxiosConfig('https://ci-portal.localhost', 'http://host.docker.internal:8415');

      expect(config.headers).toBeUndefined();
    });

    it('merges per-request headers without dropping the bridged Host header', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const config = withPortalAxiosHeaders(buildPortalAxiosConfig('https://ci-portal.localhost'), {
        'Content-Type': 'application/json',
      });

      expect(config.headers).toMatchObject({
        Host: 'ci-portal.localhost',
        'Content-Type': 'application/json',
      });
    });
  });
});
