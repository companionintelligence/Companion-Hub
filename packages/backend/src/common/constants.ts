export const APP_DIR = process.env.CI_HUB_APP_DIR || '/app';

/** Hub state root: `.env`, `state/`, logs. In Docker this is `/data`; locally use CI_HUB_DATA_DIR or the same tree as ROOT_FOLDER_HOST. */
function resolveDataDir(): string {
  const explicit = process.env.CI_HUB_DATA_DIR || process.env.TIPI_DATA_DIR;
  if (explicit) return explicit;
  // Local `pnpm dev`: dotenv provides ROOT_FOLDER_HOST but not CI_HUB_DATA_DIR — avoid mkdir `/data` (EACCES).
  if (process.env.NODE_ENV === 'development' && process.env.ROOT_FOLDER_HOST) {
    return process.env.ROOT_FOLDER_HOST;
  }
  return '/data';
}

export const DATA_DIR = resolveDataDir();
export const APP_DATA_DIR = process.env.CI_HUB_APP_DATA_DIR || '/app-data';

export const SESSION_COOKIE_NAME = 'ci-hub-sid';
export const SESSION_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24;

export const ARCHITECTURES = ['arm64', 'amd64'] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

// ---------------------------------------------------------------------------
// Hardcoded infrastructure defaults
// These values are internal to the CI-Hub Docker stack and should never need
// to be changed by end users. They are still overridable via env vars for
// backward compatibility, but are no longer required in .env.
// ---------------------------------------------------------------------------

// Database
export const DEFAULT_POSTGRES_HOST = 'ci-hub-db';
export const DEFAULT_POSTGRES_DBNAME = 'companiondb';
export const DEFAULT_POSTGRES_USERNAME = 'companion';
export const DEFAULT_POSTGRES_PORT = '6543';

// Message queue
export const DEFAULT_RABBITMQ_HOST = 'ci-os-hub-queue';
export const DEFAULT_RABBITMQ_USERNAME = 'companion';
export const DEFAULT_RABBITMQ_PASSWORD = 'admin';

// Networking / Docker
export const DEFAULT_HUB_CONTAINER_NAME = 'ci-os-hub';
export const DEFAULT_DB_CONTAINER_NAME = 'ci-hub-db';
export const DEFAULT_QUEUE_CONTAINER_NAME = 'ci-os-hub-queue';
export const DEFAULT_TRAEFIK_CONTAINER_NAME = 'traefik';
export const DEFAULT_CLOUDFLARED_CONTAINER_NAME = 'cloudflared';
export const DEFAULT_HUB_TAILSCALE_CONTAINER_NAME = 'hub-tailscale';
export const DEFAULT_NETWORK_NAME = 'ci-os-hub_network';
export const DEFAULT_DB_VOLUME_NAME = 'ci_hub_pgdata';

// Ports
export const DEFAULT_API_PORT = '5002';
export const DEFAULT_HTTP_PORT = '80';
export const DEFAULT_HTTPS_PORT = '443';

// Traefik
export const DEFAULT_FORWARD_AUTH_URL = 'http://ci-os-hub:3000/api/auth/traefik';

// DNS
export const DEFAULT_DNS_IP = '9.9.9.9';

/** mDNS / LAN hostname used for local Traefik routes (e.g. `hub.ci.lan`) */
export const DEFAULT_LOCAL_DOMAIN = 'ci.lan';

// CI Cloud
export const DEFAULT_CI_CLOUD_URL = 'https://hub.companionintelligence.com';

// Version
export const DEFAULT_CI_HUB_VERSION = '4.5.0';

// Feature flag defaults
export const DEFAULT_DEMO_MODE = 'false';
export const DEFAULT_DISABLE_PASSWORD_RESET = 'true';
export const DEFAULT_GUEST_DASHBOARD = 'false';
export const DEFAULT_ALLOW_AUTO_THEMES = 'true';
export const DEFAULT_ALLOW_ERROR_MONITORING = 'false';
export const DEFAULT_PERSIST_TRAEFIK_CONFIG = 'false';
export const DEFAULT_QUEUE_TIMEOUT_IN_MINUTES = '5';
export const DEFAULT_MAX_BACKUPS = '0';
export const DEFAULT_ADVANCED_SETTINGS = 'false';
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_EXPERIMENTAL_INSECURE_COOKIE = 'false';

// Theming
export const DEFAULT_THEME_BASE = 'gray';
export const DEFAULT_THEME_COLOR = 'blue';
