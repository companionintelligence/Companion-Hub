import { render, screen, userEvent as user } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import ConnectAdvancedPage from './connect-advanced-page';

const navigate = vi.fn();
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useNavigate: () => navigate }));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => true,
  isMobileClient: () => true,
  usesCloudConnect: () => true,
  getHubBaseUrlSync: () => null,
  initMobileConnection: async () => ({ isMobile: true, hubBaseUrl: null }),
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const signInToPortal = vi.fn();
vi.mock('../portal-client', async (orig) => ({
  ...(await orig<typeof import('../portal-client')>()),
  signInToPortal: (...a: unknown[]) => signInToPortal(...a),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectAdvancedPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  signInToPortal.mockReset();
  toastError.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ConnectAdvancedPage', () => {
  it('shows email, password, and Companion URL — not the OIDC Log in button', () => {
    renderPage();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Companion URL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://hub.ci.computer')).toBeInTheDocument();
    expect(screen.queryByTestId('oidc-login-btn')).not.toBeInTheDocument();
    expect(screen.queryByText(/portal/i)).not.toBeInTheDocument();
  });

  it('saves the Companion URL and returns to Log in', async () => {
    renderPage();
    const urlField = screen.getByLabelText('Companion URL');
    await user.clear(urlField);
    await user.type(urlField, 'https://hub.example.test');
    await user.click(screen.getByRole('button', { name: /^save url$/i }));

    expect(localStorage.getItem('ci-hub.portalUrl')).toBe('https://hub.example.test');
    expect(navigate).toHaveBeenCalledWith('/connect');
  });

  it('email sign-in stores Portal auth and returns to /connect', async () => {
    signInToPortal.mockResolvedValue({ token: 'tok', cookie: null, kind: 'session' });
    renderPage();

    await user.type(screen.getByPlaceholderText('you@example.com'), 'you@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    await vi.waitFor(() => expect(signInToPortal).toHaveBeenCalledWith('you@example.com', 'pw', expect.any(String)));
    expect(JSON.parse(sessionStorage.getItem('ci-hub.portalAuth') ?? '{}')).toMatchObject({ token: 'tok', kind: 'session' });
    expect(navigate).toHaveBeenCalledWith('/connect');
  });

  it('email sign-in failure stays on Advanced', async () => {
    signInToPortal.mockRejectedValue(new Error('Invalid credentials'));
    renderPage();

    await user.type(screen.getByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in with email/i }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Invalid credentials'));
    expect(navigate).not.toHaveBeenCalledWith('/connect');
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  });
});
