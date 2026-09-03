/**
 * Maps Docker container image patterns to known proprietary service names.
 * Used to detect what services a user is already running.
 */
export const DOCKER_SERVICE_PATTERNS: Record<string, string> = {
  plex: 'Plex',
  'plexinc/pms-docker': 'Plex',
  emby: 'Emby',
  jellyfin: 'Jellyfin',
  nextcloud: 'Nextcloud',
  homeassistant: 'Home Assistant',
  'home-assistant': 'Home Assistant',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  portainer: 'Portainer',
  pihole: 'Pi-hole',
  'pi-hole': 'Pi-hole',
  adguard: 'AdGuard Home',
  grafana: 'Grafana',
  prometheus: 'Prometheus',
  nginx: 'Nginx',
  traefik: 'Traefik',
  wordpress: 'WordPress',
  bitwarden: 'Bitwarden',
  vaultwarden: 'Vaultwarden',
  syncthing: 'Syncthing',
  immich: 'Immich',
  navidrome: 'Navidrome',
  photoprism: 'PhotoPrism',
  freshrss: 'FreshRSS',
  paperless: 'Paperless-ngx',
  calibre: 'Calibre',
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  prowlarr: 'Prowlarr',
  lidarr: 'Lidarr',
  jackett: 'Jackett',
  transmission: 'Transmission',
  qbittorrent: 'qBittorrent',
  deluge: 'Deluge',
  overseerr: 'Overseerr',
  tautulli: 'Tautulli',
  uptime: 'Uptime Kuma',
  'uptime-kuma': 'Uptime Kuma',
  changedetection: 'Change Detection',
  n8n: 'n8n',
  'node-red': 'Node-RED',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  mongo: 'MongoDB',
  minio: 'MinIO',
};

/**
 * Infrastructure services used by the Hub itself.
 * These should never appear as "detected services" in onboarding recommendations.
 */
export const INFRASTRUCTURE_SERVICE_NAMES: ReadonlySet<string> = new Set(['Traefik', 'PostgreSQL']);

export interface DetectedService {
  name: string;
  image: string;
  status: string;
  friendlyName: string;
}

export function identifyServices(containers: Array<{ name: string; image: string; status: string }>): DetectedService[] {
  const detected: DetectedService[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    const imageLower = container.image.toLowerCase();
    const nameLower = container.name.toLowerCase();

    for (const [pattern, friendlyName] of Object.entries(DOCKER_SERVICE_PATTERNS)) {
      if ((imageLower.includes(pattern) || nameLower.includes(pattern)) && !seen.has(friendlyName)) {
        seen.add(friendlyName);
        detected.push({
          ...container,
          friendlyName,
        });
      }
    }
  }

  return detected.filter((s) => !INFRASTRUCTURE_SERVICE_NAMES.has(s.friendlyName));
}
