import path from 'node:path';

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
export const TUNNEL_DIR = process.env.CI_HUB_TUNNEL_DIR || path.join(APP_DIR, 'tunnel');

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
export const DEFAULT_NETWORK_NAME = 'ci-os-hub_network';

// Traefik
export const DEFAULT_FORWARD_AUTH_URL = 'http://ci-os-hub:3000/api/auth/traefik';

// DNS
export const DEFAULT_DNS_IP = '9.9.9.9';

/** mDNS / LAN hostname used for local Traefik routes (e.g. `hub.ci.lan`) */
export const DEFAULT_LOCAL_DOMAIN = 'ci.lan';

function isProductionEnvironmentDefault() {
  return process.env.CI_HUB_ENVIRONMENT === 'production';
}

// CI Cloud
export const DEFAULT_DEV_CI_CLOUD_URL = 'https://hub.companionintelligence.com';
export const DEFAULT_PROD_CI_CLOUD_URL = 'https://hub.ci.computer';
export const DEFAULT_CI_CLOUD_URL = isProductionEnvironmentDefault() ? DEFAULT_PROD_CI_CLOUD_URL : DEFAULT_DEV_CI_CLOUD_URL;

// Public app host domain. Dev and prod default to the SAME canonical domain so
// the offered domain subset is consistent across environments; the actual
// per-environment working domain is set from CI-Cloud at device registration
// (PairDevice returns CLOUDFLARE_DOMAIN) and validated server-side on sync.
export const DEFAULT_DEV_PUBLIC_DOMAIN = 'companionintelligence.com';
export const DEFAULT_PROD_PUBLIC_DOMAIN = 'companionintelligence.com';
export const DEFAULT_PUBLIC_DOMAIN = isProductionEnvironmentDefault() ? DEFAULT_PROD_PUBLIC_DOMAIN : DEFAULT_DEV_PUBLIC_DOMAIN;

// Feature flag defaults
export const DEFAULT_DEMO_MODE = 'false';
export const DEFAULT_DISABLE_PASSWORD_RESET = 'true';
export const DEFAULT_GUEST_DASHBOARD = 'false';
export const DEFAULT_ALLOW_AUTO_THEMES = 'true';
export const DEFAULT_ALLOW_ERROR_MONITORING = 'true';
export const DEFAULT_PERSIST_TRAEFIK_CONFIG = 'false';
export const DEFAULT_QUEUE_TIMEOUT_IN_MINUTES = '5';
/** Minimum RPC/status grace for app install while large images pull (e.g. OpenClaw ~1GB). */
export const DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES = 45;
/** Global mutex key: only one app install (image pull / compose up) at a time. */
export const INSTALL_PIPELINE_MUTEX_KEY = '__install-pipeline__';
export const DEFAULT_MAX_BACKUPS = '0';
export const DEFAULT_ADVANCED_SETTINGS = 'false';
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_EXPERIMENTAL_INSECURE_COOKIE = 'false';

// Hub stack container — CI Cloud OCI repo for tag listing and GHCR image pulls (keep aligned).
export const HUB_STACK_REGISTRY_REPO = 'ci-os-hub';
export const HUB_STACK_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-os-hub';

// Theming
export const DEFAULT_THEME_BASE = 'gray';
export const DEFAULT_THEME_COLOR = 'blue';
