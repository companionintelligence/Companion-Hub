// API client types — mirrored from the auto-generated React frontend types
// These are the contracts with the backend and must stay in sync.

export interface UserContextDto {
  allowAutoThemes: boolean;
  allowErrorMonitoring: boolean;
  isConfigured: boolean;
  isGuestDashboardEnabled: boolean;
  isLoggedIn: boolean;
  isPasswordResetDisabled: boolean;
  localDomain: string;
  domain: string;
  sslPort: number;
  themeBase: string;
  themeColor: string;
  version: VersionInfo;
}

export interface VersionInfo {
  body: string;
  current: string;
  latest: string;
  releases: Array<{ body: string; version: string }>;
}

export type AppCategory =
  | 'ai' | 'automation' | 'books' | 'data' | 'development'
  | 'featured' | 'finance' | 'gaming' | 'media' | 'music'
  | 'network' | 'photography' | 'security' | 'social' | 'utilities';

export interface AppSummary {
  available: boolean;
  categories: AppCategory[];
  created_at: number;
  deprecated: boolean;
  id: string;
  name: string;
  short_desc: string;
  supported_architectures: Array<'amd64' | 'arm64'>;
  urn: string;
}

export interface AppContextDto {
  apps: AppSummary[];
  updatesAvailable: number;
  isProduction: boolean;
  cloudflareAvailable: boolean;
  tailscaleAvailable: boolean;
  user: {
    hasCompletedOnboarding: boolean;
    id: number;
    locale: string;
    operator: boolean;
    totpEnabled: boolean;
    username: string;
    advancedMode: boolean;
  };
  userSettings: {
    advancedSettings: boolean;
    allowAutoThemes: boolean;
    allowErrorMonitoring: boolean;
    appDataPath: string;
    appsRepoUrl: string;
    demoMode: boolean;
    disablePasswordReset: boolean;
    dnsIp: string;
    domain: string;
    eventsTimeout: number;
    forwardAuthUrl: string;
    guestDashboard: boolean;
    internalIp: string;
    listenIp: string;
    localDomain: string;
    logLevel: 'debug' | 'error' | 'info' | 'warn';
    maxBackups: number;
    persistTraefikConfig: boolean;
    port: number;
    postgresPort: number;
    sslPort: number;
    timeZone: string;
    experimental_insecureCookie?: boolean;
    themeBase?: string;
    themeColor?: string;
    ciHubOrganizationSlug?: string;
    ciHubDeviceSlug?: string;
  };
  version: VersionInfo;
}

export interface LoginBody {
  username: string;
  password: string;
  totpCode?: string;
}

export interface RegisterBody {
  username: string;
  password: string;
}
