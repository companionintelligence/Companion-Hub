// API client types — mirrored from the auto-generated React frontend types

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
  userSettings: UserSettings;
  version: VersionInfo;
}

export interface UserSettings {
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
}

export interface LoginBody {
  username: string;
  password: string;
}

export interface LoginDto {
  success: boolean;
  totpSessionId?: string;
  sessionId?: string;
}

export interface RegisterBody {
  username: string;
  password: string;
}

export interface RegisterDto {
  success: boolean;
}

export type AppStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'installing' | 'uninstalling' | 'missing' | 'updating' | 'backing_up' | 'restoring' | 'resetting' | 'restarting';

export interface LoadDto {
  cpuLoad: number;
  diskSize: number;
  diskUsed: number;
  memoryTotal: number;
  percentUsed: number;
  percentUsedMemory: number;
}

export interface AppFormField {
  type: 'text' | 'password' | 'email' | 'number' | 'fqdn' | 'ip' | 'url' | 'random' | 'boolean';
  label: string;
  required: boolean;
  env_variable: string;
  default?: string | boolean | number;
  hint?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  regex?: string;
  pattern_error?: string;
  options?: { label: string; value: string }[];
}

export interface AppInfo {
  id: string;
  urn: string;
  name: string;
  short_desc: string;
  author: string;
  available: boolean;
  categories: AppCategory[];
  created_at: number;
  deprecated: boolean;
  description: string;
  dynamic_config: boolean;
  exposable: boolean;
  form_fields: AppFormField[];
  https: boolean;
  no_gui: boolean;
  port: number;
  source: string;
  supported_architectures: Array<'amd64' | 'arm64'>;
  url_suffix: string;
  version: string;
  website: string;
}

export interface AppMetadata {
  latestVersion: string;
  latestDockerVersion: string;
  hasUpdateAvailable: boolean;
}

export interface AppDetails {
  id: number;
  status: AppStatus;
  version: string;
  domain: string | null;
  exposed: boolean;
  exposedLocal: boolean;
  openPort: boolean;
  port: number | null;
  localSubdomain: string;
  ignoredVersion: string | null;
  pendingRestart: boolean;
  config: Record<string, string>;
}

export interface GetAppDto {
  info: AppInfo;
  app: AppDetails | null;
  metadata: AppMetadata;
}

export interface InstalledApp {
  info: AppInfo;
  app: AppDetails;
  metadata: AppMetadata;
}

export interface InstalledAppsDto {
  installed: InstalledApp[];
}

export interface CustomLink {
  id: number;
  title: string;
  url: string;
  iconUrl: string | null;
  description: string | null;
}

export interface LinksDto {
  links: CustomLink[];
}

export interface SearchAppsDto {
  data: AppSummary[];
  nextCursor: string | null;
  total: number;
}

export interface AppStoreInfo {
  id: number;
  name: string;
  slug: string;
  url: string;
  hash: string;
  enabled: boolean;
}

export interface AllAppStoresDto {
  appStores: AppStoreInfo[];
}

export interface EnabledAppStoresDto {
  appStores: AppStoreInfo[];
}

export interface AppBackup {
  id: string;
  date: string;
  size: number;
}

export interface AppBackupsDto {
  data: AppBackup[];
}

export interface GuestAppsDto {
  installed: Array<{
    info: AppInfo;
    app: AppDetails & { localSubdomain: string };
  }>;
}

export interface GuestLinksDto {
  links: CustomLink[];
}

export interface CheckResetPasswordRequestDto {
  isRequestPending: boolean;
}

export interface ResetPasswordDto {
  email: string;
  success: boolean;
}

export interface GetTotpUriDto {
  key: string;
  uri: string;
}

export interface UserSettingsBody {
  advancedSettings?: boolean;
  allowAutoThemes?: boolean;
  allowErrorMonitoring?: boolean;
  appDataPath?: string;
  appsRepoUrl?: string;
  demoMode?: boolean;
  disablePasswordReset?: boolean;
  dnsIp?: string;
  domain?: string;
  eventsTimeout?: number | string;
  experimental_insecureCookie?: boolean;
  forwardAuthUrl?: string;
  guestDashboard?: boolean;
  internalIp?: string;
  listenIp?: string;
  localDomain?: string;
  logLevel?: 'debug' | 'error' | 'info' | 'warn';
  maxBackups?: number | string;
  persistTraefikConfig?: boolean;
  port?: number | string;
  postgresPort?: number | string;
  sslPort?: number | string;
  themeBase?: string;
  themeColor?: string;
  timeZone?: string;
}

export interface UserConfigDto {
  config: Record<string, string>;
  enabled: boolean;
  schema: Record<string, unknown>;
}

export interface SSEEvent {
  topic: 'app';
  data: {
    event: string;
    appUrn: string;
    appStatus?: AppStatus;
    error?: string;
    progress?: number;
  };
}
