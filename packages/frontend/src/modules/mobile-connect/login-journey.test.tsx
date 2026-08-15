/**
 * End-to-end mobile LOGIN JOURNEY tests.
 *
 * Unlike the unit tests (connect-page / portal-client / oidc / mobile-connection),
 * these drive the *routed* flow with react-router's `createRoutesStub`: the real
 * `ConnectPage` + its `clientLoader` + real `useNavigate` navigation across the
 * `/connect` → `/login` handoff. Only the external boundaries are mocked — the
 * Portal HTTP client, the OIDC browser round-trip, and the mobile-connection
 * store — so no real credentials or network are involved and the whole thing
 * runs in the normal CI test job.
 *
 * The mobile-connection mock is *stateful* (a chosen Hub URL + a native-fetch
 * flag) so the journeys assert real state-driven routing and prove the exact
 * regression that broke live login: after picking a Hub, the native fetch must
 * be active before the `/login` handoff.
 */
import { render, screen, userEvent as user } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import ConnectPage, { clientLoader as connectLoader } from './pages/connect-page';
import type { HubDevice } from './portal-client';

// ── Stateful mobile-connection boundary ────────────────────────────────────
const conn = vi.hoisted(() => ({ mobile: true, hubUrl: null as string | null, nativeFetchActive: false }));
const mc = vi.hoisted(() => ({
  setHub: vi.fn(async (url: string) => {
    conn.hubUrl = url;
    conn.nativeFetchActive = true; // setHubConnection must ensure native fetch (the fixed bug)
  }),
  clearHub: vi.fn(async () => {
    conn.hubUrl = null;
  }),
  init: vi.fn(async () => ({ isMobile: conn.mobile, hubBaseUrl: conn.hubUrl })),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => conn.mobile,
  isMobileClient: () => conn.mobile,
  getHubBaseUrlSync: () => conn.hubUrl,
  setHubConnection: (url: string) => mc.setHub(url),
  clearHubConnection: () => mc.clearHub(),
  initMobileConnection: () => mc.init(),
}));

// ── Portal + OIDC boundaries ───────────────────────────────────────────────
const signInToPortal = vi.fn();
const listHubDevices = vi.fn();
vi.mock('./portal-client', async (orig) => ({
  ...(await orig<typeof import('./portal-client')>()),
  signInToPortal: (...a: unknown[]) => signInToPortal(...a),
  listHubDevices: (...a: unknown[]) => listHubDevices(...a),
}));

const loginWithPortalOidc = vi.fn();
const resumePendingOidcLogin = vi.fn<(...args: unknown[]) => Promise<null>>(async () => null);
vi.mock('./oidc', async (orig) => ({
  ...(await orig<typeof import('./oidc')>()),
  loginWithPortalOidc: (...a: unknown[]) => loginWithPortalOidc(...a),
  resumePendingOidcLogin: (...a: unknown[]) => resumePendingOidcLogin(...a),
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { error: toastError, success: vi.fn() } }));

const DEVICES: HubDevice[] = [
  { id: 'reg-1', name: 'Apple Hub', status: 'active', hubUrl: 'https://hub-apple.ci.computer' },
  { id: 'reg-2', name: 'Pending Hub', status: 'pending', hubUrl: null },
];

// A tiny stand-in for the Hub's own /login screen the connect flow hands off to.
function HubLoginScreen() {
  return <div data-testid="hub-login-screen">Hub sign-in</div>;
}
function HomeScreen() {
  return <div data-testid="home-screen">Home</div>;
}

function renderJourney(initial = '/connect') {
  const Stub = createRoutesStub([
    { path: '/connect', Component: ConnectPage, loader: connectLoader },
    { path: '/login', Component: HubLoginScreen },
    { path: '/', Component: HomeScreen },
  ]);
  return render(<Stub initialEntries={[initial]} />);
}

beforeEach(() => {
  conn.mobile = true;
  conn.hubUrl = null;
  conn.nativeFetchActive = false;
  mc.setHub.mockClear();
  mc.clearHub.mockClear();
  mc.init.mockClear();
  signInToPortal.mockReset();
  listHubDevices.mockReset();
  loginWithPortalOidc.mockReset();
  resumePendingOidcLogin.mockReset();
  resumePendingOidcLogin.mockResolvedValue(null);
  toastError.mockClear();
});

describe('mobile login journey', () => {
  it('email → Portal → pick Hub → hands off to /login with native fetch active', async () => {
    signInToPortal.mockResolvedValue({ token: 'sess-tok', cookie: null });
    listHubDevices.mockResolvedValue(DEVICES);
    renderJourney();

    // Lands on the connect screen.
    expect(await screen.findByText('Connect to your Hub')).toBeInTheDocument();

    // Sign in with email.
    await user.type(screen.getByPlaceholderText('you@example.com'), 'you@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    // Portal returns the Hub list.
    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(signInToPortal).toHaveBeenCalledWith('you@example.com', 'pw', expect.any(String));

    // Pick the reachable Hub → hands off to /login.
    await user.click(screen.getByTestId('hub-row-reg-1'));

    expect(await screen.findByTestId('hub-login-screen')).toBeInTheDocument();
    // The exact regression guard: the connection + native fetch are established
    // before the /login POST would fire.
    expect(mc.setHub).toHaveBeenCalledWith('https://hub-apple.ci.computer');
    expect(conn.hubUrl).toBe('https://hub-apple.ci.computer');
    expect(conn.nativeFetchActive).toBe(true);
  });

  it('OIDC → Portal → pick Hub → hands off to /login', async () => {
    loginWithPortalOidc.mockResolvedValue({ accessToken: 'AT', idToken: null, tokenType: 'Bearer', expiresIn: 3600 });
    listHubDevices.mockResolvedValue(DEVICES);
    renderJourney();

    await user.click(await screen.findByTestId('oidc-login-btn'));

    // The OIDC access token is forwarded to the Portal device listing.
    expect(await screen.findByText('Apple Hub')).toBeInTheDocument();
    expect(listHubDevices).toHaveBeenCalledWith({ token: 'AT', cookie: null, kind: 'oauth' }, expect.any(String));

    await user.click(screen.getByTestId('hub-row-reg-1'));
    expect(await screen.findByTestId('hub-login-screen')).toBeInTheDocument();
    expect(conn.hubUrl).toBe('https://hub-apple.ci.computer');
  });

  it('an already-connected device is routed off /connect to the app (not stranded on the picker)', async () => {
    conn.hubUrl = 'https://hub-apple.ci.computer'; // returning user with a chosen Hub
    renderJourney('/connect');
    // clientLoader sees a chosen Hub → redirects to that Hub's /login.
    expect(await screen.findByTestId('hub-login-screen')).toBeInTheDocument();
    expect(screen.queryByText('Connect to your Hub')).not.toBeInTheDocument();
  });

  it('web/desktop never see the mobile-only connect screen', async () => {
    conn.mobile = false;
    renderJourney('/connect');
    expect(await screen.findByTestId('home-screen')).toBeInTheDocument();
  });

  it('bad credentials surface an error and keep the user on the connect screen', async () => {
    signInToPortal.mockRejectedValue(new Error('Invalid credentials'));
    renderJourney();

    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Invalid credentials'));
    expect(listHubDevices).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hub-login-screen')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(mc.setHub).not.toHaveBeenCalled();
  });

  it('an unreachable Hub cannot be connected (row disabled, no handoff)', async () => {
    signInToPortal.mockResolvedValue({ token: 'sess-tok', cookie: null });
    listHubDevices.mockResolvedValue(DEVICES);
    renderJourney();

    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    const unreachable = await screen.findByTestId('hub-row-reg-2');
    expect(unreachable).toBeDisabled();
    await user.click(unreachable); // no-op
    expect(mc.setHub).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hub-login-screen')).not.toBeInTheDocument();
  });
});
