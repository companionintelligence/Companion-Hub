import type { UserContextDto, AppContextDto, LoginBody, RegisterBody } from './types';

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

export const api = {
  getUserContext: () => apiFetch<UserContextDto>('/user-context'),
  getAppContext: () => apiFetch<AppContextDto>('/app-context'),
  login: (body: LoginBody) =>
    apiFetch<void>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  logout: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
  register: (body: RegisterBody) =>
    apiFetch<void>('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getRegistrationStatus: async (): Promise<{ registered: boolean }> => {
    const res = await fetch('/api/registration/status', {
      credentials: 'include',
      headers: getHeaders(),
    });
    if (!res.ok) return { registered: false };
    return res.json();
  },
};

export type { UserContextDto, AppContextDto } from './types';
