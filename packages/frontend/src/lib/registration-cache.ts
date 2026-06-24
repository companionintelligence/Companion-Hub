import type { RegistrationStatus } from './registration-status';
import { isRegistrationOperational, requiresDeviceRegistration } from './registration-status';
import { apiFetch } from './api-fetch';

export async function resolveRegistrationStatus(): Promise<RegistrationStatus | null> {
  try {
    const res = await apiFetch('/api/registration/status');
    if (!res.ok) {
      return null;
    }

    const status = (await res.json()) as RegistrationStatus;
    cacheRegistrationStatus(status);
    return status;
  } catch {
    return null;
  }
}

const REGISTRATION_CACHE_TTL_MS = 15 * 1000;
const CACHE_KEY = 'device-registered';
const CACHE_AT_KEY = 'device-registered-at';

export function cacheRegistrationStatus(status: RegistrationStatus): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  if (isRegistrationOperational(status) && !requiresDeviceRegistration(status)) {
    sessionStorage.setItem(CACHE_KEY, 'true');
    sessionStorage.setItem(CACHE_AT_KEY, String(Date.now()));
    return;
  }

  clearRegistrationCache();
}

export function clearRegistrationCache(): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  sessionStorage.removeItem(CACHE_KEY);
  sessionStorage.removeItem(CACHE_AT_KEY);
}

export function getCachedRegistrationStatus(): RegistrationStatus | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  const cachedAt = Number(sessionStorage.getItem(CACHE_AT_KEY) || '0');
  const cacheValid = sessionStorage.getItem(CACHE_KEY) === 'true' && Date.now() - cachedAt < REGISTRATION_CACHE_TTL_MS;

  if (!cacheValid) {
    return null;
  }

  return {
    phase: 'locally_ready',
    degradedReasons: [],
    registered: true,
  };
}
