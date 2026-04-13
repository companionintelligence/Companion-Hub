import type {
  UserContextDto, AppContextDto, LoginBody, LoginDto, RegisterBody,
  LoadDto, InstalledAppsDto, SearchAppsDto, GetAppDto, LinksDto,
  AllAppStoresDto, EnabledAppStoresDto, AppBackupsDto, GuestAppsDto,
  GuestLinksDto, CheckResetPasswordRequestDto, ResetPasswordDto,
  GetTotpUriDto, UserSettingsBody, UserConfigDto, CustomLink,
  AppStoreInfo,
} from './types';

// Session ID storage for Tauri release mode
let tauriSessionId: string | null = null;

export function setTauriSessionId(id: string | null) {
  tauriSessionId = id;
  if (id) {
    sessionStorage.setItem('ci-hub-session', id);
  } else {
    sessionStorage.removeItem('ci-hub-session');
  }
}

export function getTauriSessionId(): string | null {
  if (tauriSessionId) return tauriSessionId;
  tauriSessionId = sessionStorage.getItem('ci-hub-session');
  return tauriSessionId;
}

function getHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const sid = getTauriSessionId();
  if (sid) {
    headers.set('X-CI-Hub-Session', sid);
  }
  return headers;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = getHeaders(init?.headers);
  const res = await fetch(`/api${path}`, { credentials: 'include', ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.message) message = data.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json();
}

async function apiVoid(path: string, init?: RequestInit): Promise<void> {
  const headers = getHeaders(init?.headers);
  const res = await fetch(`/api${path}`, { credentials: 'include', ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.message) message = data.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
}

export async function rawApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = getHeaders(init?.headers);
  return fetch(`/api${path}`, { credentials: 'include', ...init, headers });
}

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPatch = (body: unknown) => ({
  method: 'PATCH' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPut = (body: unknown) => ({
  method: 'PUT' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  // Context
  getUserContext: () => apiFetch<UserContextDto>('/user-context'),
  getAppContext: () => apiFetch<AppContextDto>('/app-context'),

  // Auth
  login: (body: LoginBody) => apiFetch<LoginDto>('/auth/login', json(body)),
  logout: () => apiVoid('/auth/logout', { method: 'POST' }),
  register: (body: RegisterBody) => apiFetch<{ success: boolean }>('/auth/register', json(body)),
  verifyTotp: (body: { totpCode: string; totpSessionId: string }) => apiFetch<{ success: boolean }>('/auth/totp/verify', json(body)),

  // Registration
  getRegistrationStatus: async (): Promise<{ registered: boolean }> => {
    const res = await rawApiFetch('/registration/status');
    if (!res.ok) return { registered: false };
    return res.json();
  },
  getDeviceId: () => apiFetch<{ device_id: string; ci_cloud_url?: string }>('/registration/device-id'),
  pairDevice: (body: { pairing_code: string }) => apiFetch<{ success: boolean; domain?: string; subdomain?: string }>('/registration/pair', json(body)),
  probeDomain: (url: string) => apiFetch<{ ready: boolean }>(`/registration/probe-domain?url=${encodeURIComponent(url)}`),

  // System
  systemLoad: () => apiFetch<LoadDto>('/system/load'),
  downloadCertificate: () => rawApiFetch('/system/certificate'),

  // Password Reset
  checkResetPasswordRequest: () => apiFetch<CheckResetPasswordRequestDto>('/auth/reset-password'),
  resetPassword: (body: { newPassword: string }) => apiFetch<ResetPasswordDto>('/auth/reset-password', json(body)),
  cancelResetPassword: () => apiVoid('/auth/reset-password', { method: 'DELETE' }),

  // TOTP
  getTotpUri: (body: { password: string }) => apiFetch<GetTotpUriDto>('/auth/totp', json(body)),
  setupTotp: (body: { code: string }) => apiFetch<{ success: boolean }>('/auth/totp/setup', json(body)),
  disableTotp: (body: { password: string }) => apiFetch<{ success: boolean }>('/auth/totp/disable', json(body)),

  // User
  changeUsername: (body: { newUsername: string; password: string }) => apiFetch<{ success: boolean }>('/auth/username', jsonPatch(body)),
  changePassword: (body: { currentPassword: string; newPassword: string }) => apiFetch<{ success: boolean }>('/auth/password', jsonPatch(body)),
  updateUserSettings: (body: UserSettingsBody) => apiFetch<{ success: boolean }>('/user-settings', jsonPatch(body)),
  updateAdvancedMode: (body: { advancedMode: boolean }) => apiFetch<{ success: boolean }>('/user-advanced-mode', jsonPatch(body)),
  acknowledgeWelcome: (body: { allowErrorMonitoring: boolean }) => apiFetch<{ success: boolean }>('/acknowledge-welcome', jsonPatch(body)),

  // Apps
  getInstalledApps: () => apiFetch<InstalledAppsDto>('/apps/installed'),
  searchApps: (params: { search?: string; category?: string; pageSize?: number; storeId?: string; cursor?: string }) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.category) q.set('category', params.category);
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.storeId) q.set('storeId', params.storeId);
    if (params.cursor) q.set('cursor', params.cursor);
    return apiFetch<SearchAppsDto>(`/apps/search?${q}`);
  },
  getApp: (urn: string) => apiFetch<GetAppDto>(`/apps/${urn}`),
  installApp: (urn: string, body: Record<string, unknown>) => apiFetch<void>(`/apps/${urn}/install`, json(body)),
  startApp: (urn: string) => apiFetch<void>(`/apps/${urn}/start`, { method: 'POST' }),
  stopApp: (urn: string) => apiFetch<void>(`/apps/${urn}/stop`, { method: 'POST' }),
  restartApp: (urn: string) => apiFetch<void>(`/apps/${urn}/restart`, { method: 'POST' }),
  uninstallApp: (urn: string) => apiFetch<void>(`/apps/${urn}/uninstall`, { method: 'DELETE' }),
  updateApp: (urn: string) => apiFetch<void>(`/apps/${urn}/update`, { method: 'POST' }),
  resetApp: (urn: string) => apiFetch<void>(`/apps/${urn}/reset`, { method: 'POST' }),
  updateAppConfig: (urn: string, body: Record<string, string>) => apiFetch<void>(`/apps/${urn}/config`, jsonPut(body)),
  getAppImageSize: (urn: string) => apiFetch<{ totalBytes: number | null; formatted: string | null }>(`/marketplace/apps/${urn}/image-size`),

  // User Config
  getUserConfig: (urn: string) => apiFetch<UserConfigDto>(`/apps/${urn}/user-config`),
  enableUserConfig: (urn: string) => apiFetch<void>(`/apps/${urn}/user-config/enable`, { method: 'POST' }),
  disableUserConfig: (urn: string) => apiFetch<void>(`/apps/${urn}/user-config/disable`, { method: 'POST' }),
  updateUserConfig: (urn: string, body: Record<string, string>) => apiFetch<void>(`/apps/${urn}/user-config`, jsonPut(body)),

  // Backups
  getAppBackups: (urn: string) => apiFetch<AppBackupsDto>(`/apps/${urn}/backups`),
  backupApp: (urn: string) => apiFetch<void>(`/apps/${urn}/backups`, { method: 'POST' }),
  deleteAppBackup: (urn: string, backupId: string) => apiFetch<void>(`/apps/${urn}/backups/${backupId}`, { method: 'DELETE' }),
  restoreAppBackup: (urn: string, backupId: string) => apiFetch<void>(`/apps/${urn}/backups/${backupId}/restore`, { method: 'POST' }),

  // Links
  getLinks: () => apiFetch<LinksDto>('/links'),
  createLink: (body: Omit<CustomLink, 'id'>) => apiFetch<CustomLink>('/links', json(body)),
  editLink: (id: number, body: Partial<CustomLink>) => apiFetch<CustomLink>(`/links/${id}`, jsonPatch(body)),
  deleteLink: (id: number) => apiFetch<void>(`/links/${id}`, { method: 'DELETE' }),

  // App Stores
  getAllAppStores: () => apiFetch<AllAppStoresDto>('/app-stores'),
  getEnabledAppStores: () => apiFetch<EnabledAppStoresDto>('/app-stores/enabled'),
  createAppStore: (body: { name: string; url: string }) => apiFetch<AppStoreInfo>('/app-stores', json(body)),
  updateAppStore: (id: number, body: { name: string; url: string }) => apiFetch<AppStoreInfo>(`/app-stores/${id}`, jsonPut(body)),
  deleteAppStore: (id: number) => apiFetch<void>(`/app-stores/${id}`, { method: 'DELETE' }),
  pullAppStores: () => apiFetch<void>('/app-stores/pull', { method: 'POST' }),

  // Guest
  getGuestApps: () => apiFetch<GuestAppsDto>('/guest/apps'),
  getGuestLinks: () => apiFetch<GuestLinksDto>('/guest/links'),

  // Onboarding / service detection
  detectServices: () => apiFetch<{ services: Array<{ name: string; port: number }> }>('/system/detect-services'),
};

export type { UserContextDto, AppContextDto } from './types';
