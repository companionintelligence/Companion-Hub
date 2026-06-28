import { render, screen, userEvent as user } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { OidcCancelledError } from '../oidc';
import type { HubDevice } from '../portal-client';
import ConnectPage from './connect-page';

const navigate = vi.fn();
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useNavigate: () => navigate }));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => true,
  getHubBaseUrlSync: () => null,
  initMobileConnection: vi.fn(),
  setHubConnection: vi.fn(async () => {}),
}));

const signInToPortal = vi.fn();
const listHubDevices = vi.fn();
vi.mock('../portal-client', async (orig) => ({
  ...(await orig<typeof import('../portal-client')>()),
  signInToPortal: (...a: unknown[]) => signInToPortal(...a),
  listHubDevices: (...a: unknown[]) => listHubDevices(...a),
}));

const loginWithPortalOidc = vi.fn();
vi.mock('../oidc', async (orig) => ({
  ...(await orig<typeof import('../oidc')>()),
  loginWithPortalOidc: (...a: unknown[]) => loginWithPortalOidc(...a),
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
});

describe('ConnectPage', () => {
  it('shows the OIDC button and the email fallback form', () => {
    renderPage();
    expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
  });

  it('email sign-in loads the Hub list and disables unreachable Hubs', async () => {
    signInToPortal.mockResolvedValue({ token: 'tok', cookie: null });
    listHubDevices.mockResolvedValue(devices);
    renderPage();

    await user.type(screen.getByPlaceholderText('you@example.com'), 'you@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(signInToPortal).toHaveBeenCalledWith('you@example.com', 'pw', expect.any(String));

    expect(screen.getByTestId('hub-row-reg-1')).toBeEnabled();
    expect(screen.getByTestId('hub-row-reg-2')).toBeDisabled(); // no hubUrl → unreachable
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });

  it('connecting to a reachable Hub navigates to /login', async () => {
    signInToPortal.mockResolvedValue({ token: 'tok', cookie: null });
    listHubDevices.mockResolvedValue(devices);
    renderPage();
    await user.type(screen.getByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));
    await user.click(await screen.findByTestId('hub-row-reg-1'));
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('OIDC flow shows a cancel affordance and aborts cleanly', async () => {
    // Resolve/reject only when the caller aborts via the AbortSignal.
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

    await user.click(cancel);

    // After cancel the form returns (no error toast, no crash).
    expect(await screen.findByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-oidc-btn')).not.toBeInTheDocument();
  });
});
