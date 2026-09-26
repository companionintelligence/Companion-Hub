import { render, screen, userEvent as user } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { OidcCancelledError } from '../oidc';
import type { HubDevice } from '../portal-client';
import ConnectPage, { clientLoader } from './connect-page';

const navigate = vi.fn();
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useNavigate: () => navigate }));

const { setHubConnection, toastError, initMobileConnection, isMobileClient } = vi.hoisted(() => ({
  setHubConnection: vi.fn(async () => {}),
  toastError: vi.fn(),
  initMobileConnection: vi.fn(async () => ({ isMobile: true, hubBaseUrl: null as string | null })),
  isMobileClient: vi.fn(() => true),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => true,
  isMobileClient,
  usesCloudConnect: () => isMobileClient(),
  getHubBaseUrlSync: () => null,
  initMobileConnection,
  setHubConnection,
}));
vi.mock('@/lib/hub-runtime-mode', () => ({
  isTauriDesktopApp: () => false,
}));

vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const signInToPortal = vi.fn();
const listHubDevices = vi.fn();
vi.mock('../portal-client', async (orig) => ({
  ...(await orig<typeof import('../portal-client')>()),
  signInToPortal: (...a: unknown[]) => signInToPortal(...a),
  listHubDevices: (...a: unknown[]) => listHubDevices(...a),
}));

const loginWithPortalOidc = vi.fn();
const resumePendingOidcLogin = vi.fn<(...args: unknown[]) => Promise<import('../oidc').OidcTokens | null>>(async () => null);
vi.mock('../oidc', async (orig) => ({
  ...(await orig<typeof import('../oidc')>()),
  loginWithPortalOidc: (...a: unknown[]) => loginWithPortalOidc(...a),
  resumePendingOidcLogin: (...a: unknown[]) => resumePendingOidcLogin(...a),
}));

const devices: HubDevice[] = [
  { id: 'reg-1', name: 'Apple Hub', status: 'active', hubUrl: 'https://hub-apple.ci.computer' },
  { id: 'reg-2', name: 'Pending Hub', status: 'pending', hubUrl: null },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  signInToPortal.mockReset();
  listHubDevices.mockReset();
  loginWithPortalOidc.mockReset();
  resumePendingOidcLogin.mockReset();
  resumePendingOidcLogin.mockResolvedValue(null);
  setHubConnection.mockClear();
  toastError.mockClear();
  initMobileConnection.mockReset();
  initMobileConnection.mockResolvedValue({ isMobile: true, hubBaseUrl: null });
  isMobileClient.mockReturnValue(true);
  localStorage.clear();
  sessionStorage.clear();
});

describe('ConnectPage clientLoader (connect ↔ /login handoff guard)', () => {
  it('renders the connect screen on mobile when no Hub is chosen yet', async () => {
    initMobileConnection.mockResolvedValue({ isMobile: true, hubBaseUrl: null });
    expect(await clientLoader()).toBeNull();
  });

  it('bounces off /connect once a Hub is already chosen (avoids stranding the picker)', async () => {
    initMobileConnection.mockResolvedValue({ isMobile: true, hubBaseUrl: 'https://hub-x.ci.computer' });
    const res = (await clientLoader()) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('redirects web/desktop away from the mobile-only connect screen', async () => {
    initMobileConnection.mockResolvedValue({ isMobile: false, hubBaseUrl: null });
    isMobileClient.mockReturnValue(false);
    const res = (await clientLoader()) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
  });

  it('keeps the connect screen on a phone UA even when Tauri is not detected yet', async () => {
    initMobileConnection.mockResolvedValue({ isMobile: false, hubBaseUrl: null });
    isMobileClient.mockReturnValue(true);
    expect(await clientLoader()).toBeNull();
  });
});

describe('ConnectPage', () => {
  it('shows the CI logo, Log in, and Advanced — not email or a URL field', () => {
    renderPage();
    expect(screen.getByTestId('oidc-login-btn')).toHaveTextContent('Log in');
    expect(screen.getByTestId('advanced-link')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Companion URL')).not.toBeInTheDocument();
  });

  it('Advanced opens the advanced screen', async () => {
    renderPage();
    await user.click(screen.getByTestId('advanced-link'));
    expect(navigate).toHaveBeenCalledWith('/connect/advanced');
  });

  it('resolves every i18n key (no raw MOBILE_CONNECT_* leaks through)', () => {
    const { container } = renderPage();
    expect(screen.getByText('Log in')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/MOBILE_CONNECT_/);
  });

  it('resumes a cold-start OIDC callback on mount and shows the Hub picker', async () => {
    resumePendingOidcLogin.mockResolvedValue({ accessToken: 'AT', idToken: null, tokenType: 'Bearer', expiresIn: 3600 });
    listHubDevices.mockResolvedValue(devices);
    renderPage();

    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(listHubDevices).toHaveBeenCalledWith({ token: 'AT', cookie: null, kind: 'oauth' }, expect.any(String));
  });

  it('resumes email Portal auth stored by Advanced and shows the Hub picker', async () => {
    sessionStorage.setItem('ci-hub.portalAuth', JSON.stringify({ token: 'sess', cookie: null, kind: 'session' }));
    listHubDevices.mockResolvedValue(devices);
    renderPage();

    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(listHubDevices).toHaveBeenCalledWith({ token: 'sess', cookie: null, kind: 'session' }, expect.any(String));
  });

  it('OIDC sign-in remembers the Portal email from the id_token', async () => {
    const payload = btoa(JSON.stringify({ email: 'user@example.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    loginWithPortalOidc.mockResolvedValue({
      accessToken: 'AT',
      idToken: `hdr.${payload}.sig`,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    listHubDevices.mockResolvedValue(devices);
    renderPage();

    await user.click(screen.getByTestId('oidc-login-btn'));

    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBe('user@example.com');
  });

  it('OIDC sign-in success loads the Hub picker', async () => {
    loginWithPortalOidc.mockResolvedValue({ accessToken: 'AT', idToken: null, tokenType: 'Bearer', expiresIn: 3600 });
    listHubDevices.mockResolvedValue(devices);
    renderPage();

    await user.click(screen.getByTestId('oidc-login-btn'));

    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(listHubDevices).toHaveBeenCalledWith({ token: 'AT', cookie: null, kind: 'oauth' }, expect.any(String));
  });

  it('connecting to a reachable Hub applies the connection then hands off to /login', async () => {
    loginWithPortalOidc.mockResolvedValue({ accessToken: 'AT', idToken: null, tokenType: 'Bearer', expiresIn: 3600 });
    listHubDevices.mockResolvedValue(devices);
    renderPage();
    await user.click(screen.getByTestId('oidc-login-btn'));
    await user.click(await screen.findByTestId('hub-row-reg-1'));

    expect(setHubConnection).toHaveBeenCalledWith('https://hub-apple.ci.computer');
    expect(navigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('OIDC failure (not a cancel) surfaces an error toast', async () => {
    loginWithPortalOidc.mockRejectedValue(new Error('Token exchange failed (400)'));
    renderPage();

    await user.click(screen.getByTestId('oidc-login-btn'));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Token exchange failed (400)'));
    expect(await screen.findByTestId('oidc-login-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-row-reg-1')).not.toBeInTheDocument();
  });

  it('OIDC flow shows a cancel affordance and aborts cleanly', async () => {
    loginWithPortalOidc.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new OidcCancelledError()));
        }),
    );
    renderPage();

    await user.click(screen.getByTestId('oidc-login-btn'));
    const cancel = await screen.findByTestId('cancel-oidc-btn');
    expect(cancel).toBeInTheDocument();
    expect(screen.queryByTestId('advanced-link')).not.toBeInTheDocument();

    await user.click(cancel);

    expect(await screen.findByTestId('oidc-login-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-oidc-btn')).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});
