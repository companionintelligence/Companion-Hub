import { describe, expect, it } from 'vitest';
import { INFRASTRUCTURE_SERVICE_NAMES, identifyServices } from '../service-detection';

describe('service-detection', () => {
  const makeContainer = (name: string, image: string) => ({
    name,
    image,
    status: 'running',
  });

  describe('INFRASTRUCTURE_SERVICE_NAMES', () => {
    it('includes Traefik and PostgreSQL', () => {
      expect(INFRASTRUCTURE_SERVICE_NAMES.has('Traefik')).toBe(true);
      expect(INFRASTRUCTURE_SERVICE_NAMES.has('PostgreSQL')).toBe(true);
    });
  });

  describe('identifyServices', () => {
    it('detects known services', () => {
      const containers = [makeContainer('plex', 'plexinc/pms-docker:latest'), makeContainer('jellyfin', 'jellyfin/jellyfin:latest')];
      const result = identifyServices(containers);
      expect(result.map((s) => s.friendlyName)).toEqual(['Plex', 'Jellyfin']);
    });

    it('excludes Traefik from detected services', () => {
      const containers = [makeContainer('traefik', 'traefik:v2.10'), makeContainer('plex', 'plexinc/pms-docker:latest')];
      const result = identifyServices(containers);
      expect(result.map((s) => s.friendlyName)).toEqual(['Plex']);
    });

    it('excludes PostgreSQL from detected services', () => {
      const containers = [makeContainer('postgres', 'postgres:16-alpine'), makeContainer('jellyfin', 'jellyfin/jellyfin:latest')];
      const result = identifyServices(containers);
      expect(result.map((s) => s.friendlyName)).toEqual(['Jellyfin']);
    });

    it('excludes all infrastructure services even when mixed with other services', () => {
      const containers = [
        makeContainer('traefik', 'traefik:latest'),
        makeContainer('postgres', 'postgres:16'),
        makeContainer('grafana', 'grafana/grafana:latest'),
        makeContainer('nextcloud', 'nextcloud:latest'),
      ];
      const result = identifyServices(containers);
      const names = result.map((s) => s.friendlyName);
      expect(names).toContain('Grafana');
      expect(names).toContain('Nextcloud');
      expect(names).not.toContain('Traefik');
      expect(names).not.toContain('PostgreSQL');
    });

    it('returns empty array for unknown containers', () => {
      const containers = [makeContainer('my-custom-app', 'custom/image:latest')];
      expect(identifyServices(containers)).toEqual([]);
    });
  });
});
