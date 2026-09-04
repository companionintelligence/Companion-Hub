import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR = process.env.CI_HUB_APP_DIR || '/app';

/** True inside the Hub container, where `/data` is the bind-mounted state root. */
export function detectContainerDataRoot(): boolean {
  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hub state root: `.env`, `state/`, logs. In Docker this is `/data`; locally use CI_HUB_DATA_DIR
 * or the same tree as ROOT_FOLDER_HOST.
 *
 * The `/data` default is only correct inside the container. On a host it is unwritable, and the
 * first `mkdir` during bootstrap dies with EACCES — which is what any host-side run of the backend
 * without the dotenv wrapper (bare `turbo run dev`, one-off scripts) used to hit. Probing for the
 * mount instead of trusting NODE_ENV keeps the container path exact while giving host runs a real
 * directory. ROOT_FOLDER_HOST is set inside the container too (it is the host side of the bind
 * mounts), so the container probe has to win before we consider it.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, hasContainerDataRoot: () => boolean = detectContainerDataRoot): string {
  const explicit = env.CI_HUB_DATA_DIR || env.CIHUB_DATA_DIR;
  if (explicit) return explicit;
  if (hasContainerDataRoot()) return '/data';
  return env.ROOT_FOLDER_HOST || path.join(os.homedir(), '.ci-hub');
}

export const DATA_DIR = resolveDataDir();
export const APP_DATA_DIR = process.env.CI_HUB_APP_DATA_DIR || '/app-data';
export const TUNNEL_DIR = process.env.CI_HUB_TUNNEL_DIR || path.join(APP_DIR, 'tunnel');
/** Written when the user clears the tunnel token (tray / settings). Blocks DB auto-recovery until re-paired. */
export const TUNNEL_USER_CLEARED_MARKER = '.user-cleared-token';
export const tunnelUserClearedMarkerPath = () => path.join(TUNNEL_DIR, TUNNEL_USER_CLEARED_MARKER);
/** Shared secret for the desktop host update listener (written by companion-hub desktop). */
export const UPDATE_LISTENER_TOKEN_FILENAME = 'update-listener.token';

export const SESSION_COOKIE_NAME = 'ci-hub-sid';
/** Match server-side session TTL (7 days) so browser cookies stay valid for the full session. */
export const SESSION_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

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
export const DEFAULT_RABBITMQ_HOST = 'ci-hub-queue';
/** Retired compose DNS name. Existing apps and env files may still resolve it via alias. */
export const LEGACY_RABBITMQ_HOST = 'ci-os-hub-queue';
export const DEFAULT_RABBITMQ_USERNAME = 'companion';
export const DEFAULT_RABBITMQ_PASSWORD = 'admin';

// Networking / Docker
// Canonical appliance hostname is `ci-hub` (same stem as the image, compose
// project, and @ci-hub/* packages). `ci-os-hub` remains a network alias and a
// label/lookup fallback so already-installed apps keep resolving after upgrade.
export const DEFAULT_HUB_CONTAINER_NAME = 'ci-hub';
export const LEGACY_HUB_CONTAINER_NAME = 'ci-os-hub';
export const HUB_CONTAINER_NAMES = [DEFAULT_HUB_CONTAINER_NAME, LEGACY_HUB_CONTAINER_NAME] as const;
export const DEFAULT_NETWORK_NAME = 'ci-hub_network';
export const LEGACY_NETWORK_NAME = 'ci-os-hub_network';
export const HUB_NETWORK_NAMES = [DEFAULT_NETWORK_NAME, LEGACY_NETWORK_NAME] as const;

export const HUB_MANAGED_LABEL = 'ci-hub.managed';
export const HUB_APPURN_LABEL = 'ci-hub.appurn';
export const LEGACY_HUB_MANAGED_LABEL = 'ci-os-hub.managed';
export const LEGACY_HUB_APPURN_LABEL = 'ci-os-hub.appurn';

export function hubContainerName(env: NodeJS.ProcessEnv = process.env): string {
  return env.HUB_CONTAINER_NAME || DEFAULT_HUB_CONTAINER_NAME;
}

export function hubNetworkName(env: NodeJS.ProcessEnv = process.env): string {
  return `${hubContainerName(env)}_network`;
}

export function isHubApplianceContainerName(name: string): boolean {
  const n = name.replace(/^\//, '');
  return n === DEFAULT_HUB_CONTAINER_NAME || n === LEGACY_HUB_CONTAINER_NAME;
}

export function appUrnFromLabels(labels?: Record<string, string> | null): string | undefined {
  return labels?.[HUB_APPURN_LABEL] || labels?.[LEGACY_HUB_APPURN_LABEL] || undefined;
}

export function managedAppLabels(appUrn: string): Record<string, string | boolean> {
  return {
    [HUB_MANAGED_LABEL]: true,
    [HUB_APPURN_LABEL]: appUrn,
    [LEGACY_HUB_MANAGED_LABEL]: true,
    [LEGACY_HUB_APPURN_LABEL]: appUrn,
  };
}

export function ipOnHubNetwork(networks?: Record<string, { IPAddress?: string } | undefined> | null): string | undefined {
  if (!networks) return undefined;
  for (const name of HUB_NETWORK_NAMES) {
    const ip = networks[name]?.IPAddress;
    if (ip) return ip;
  }
  return undefined;
}

// Traefik
export const DEFAULT_FORWARD_AUTH_URL = `http://${DEFAULT_HUB_CONTAINER_NAME}:3000/api/auth/traefik`;

// DNS
export const DEFAULT_DNS_IP = '9.9.9.9';

/**
 * Last-resort fallback when TZ is unset everywhere and the host time zone cannot be
 * determined. `Intl.DateTimeFormat().resolvedOptions().timeZone` returns undefined —
 * not a zone name — when ICU cannot map /etc/localtime back to an IANA id, which
 * happens whenever the host's /etc/localtime is bind-mounted into an image without
 * tzdata. Without a fallback that undefined reaches the .env writer and kills boot.
 */
export const DEFAULT_TZ = 'UTC';

/** Last-resort fallback when LOCAL_DOMAIN and DOMAIN are both unset. Prefer localhost:port for local app access. */
export const DEFAULT_LOCAL_DOMAIN = 'localhost';

function isProductionEnvironmentDefault() {
  return process.env.CI_HUB_ENVIRONMENT === 'production';
}

// Companion Portal
export const DEFAULT_DEV_CI_CLOUD_URL = 'https://hub.companionintelligence.com';
export const DEFAULT_PROD_CI_CLOUD_URL = 'https://hub.ci.computer';
export const DEFAULT_CI_CLOUD_URL = isProductionEnvironmentDefault() ? DEFAULT_PROD_CI_CLOUD_URL : DEFAULT_DEV_CI_CLOUD_URL;

// Public app host domain. Dev and prod default to the SAME canonical domain so
// the offered domain subset is consistent across environments; the actual
// per-environment working domain is set from Companion Portal at device registration
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
/** Stall timeout for a hung image pull with no progress events. */
export const DEFAULT_APP_IMAGE_PULL_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Ceiling for a per-app `docker compose` subcommand (up/down/pull/stop/...). As generous as the image
 * pull budget because `up`/`pull` can themselves pull images. Without this bound a wedged daemon/volume
 * holds the app forever in a transitional status (installing/uninstalling/updating/...) and — for
 * install — never releases INSTALL_PIPELINE_MUTEX_KEY, stranding every subsequently queued install too.
 */
export const DEFAULT_APP_COMPOSE_TIMEOUT_MINUTES = 45;
/** Stall timeout for a hung compose command producing no stdout/stderr output. */
export const DEFAULT_APP_COMPOSE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** Global mutex key: only one app install (image pull / compose up) at a time. */
export const INSTALL_PIPELINE_MUTEX_KEY = '__install-pipeline__';
export const DEFAULT_MAX_BACKUPS = '0';
export const DEFAULT_ADVANCED_SETTINGS = 'false';
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_EXPERIMENTAL_INSECURE_COOKIE = 'false';

// Hub stack container. Same package name (`ci-hub`) on two registries; do not
// point either at the retired `ci-os-hub` GHCR package (#920).
//
// - HUB_STACK_REGISTRY_REPO is the path on the Companion Portal registry, used only to LIST
//   available versions (`{ciCloudUrl}/v2/ci-hub/tags/list`). Portal receives a crane copy
//   of every production build under this name.
// - HUB_STACK_IMAGE_REPO is the GHCR repo Docker actually PULLS from. It is the package
//   `build-container.yml` publishes to, and it is public. It must match
//   HUB_STACK_IMAGE_REPO in the desktop's `hub_env.rs`; when the two disagree, the desktop
//   and this updater overwrite each other's CI_HUB_IMAGE on every start (see #920).
//
// Versions correspond across the two because both come from the same build.
// Tags are UNPREFIXED (`0.2.45`, not `v0.2.45`): pinHubStackVersionInEnv interpolates the
// raw listed tag into `<repo>:<tag>`, so a `v` would produce an unpullable reference. Note
// GHCR still carries legacy `v`-prefixed tags from a retired workflow; they are inert only
// because listing reads Portal, not GHCR. Repointing listing at GHCR would surface both
// spellings in one list and reintroduce that hazard.
export const HUB_STACK_REGISTRY_REPO = 'ci-hub';
export const HUB_STACK_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-hub';

// Theming
export const DEFAULT_THEME_BASE = 'gray';
export const DEFAULT_THEME_COLOR = 'blue';
