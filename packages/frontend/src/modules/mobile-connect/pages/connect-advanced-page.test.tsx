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

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectAdvancedPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ConnectAdvancedPage', () => {
  it('shows only the Companion URL — no email form, no OIDC Log in button', () => {
    renderPage();
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
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

    expect(localStorage.getItem('ci-hub.portalUrl.v2')).toBe('https://hub.example.test');
    expect(navigate).toHaveBeenCalledWith('/connect');
  });

  it('names the back button after where it lands: Log in when signed out', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /^back to log in$/i })).toBeInTheDocument();
  });

  it('names the back button after where it lands: the Hub picker when a Portal sign-in is stored', () => {
    sessionStorage.setItem('ci-hub.portalAuth', JSON.stringify({ token: 'AT', cookie: null, kind: 'oauth' }));
    renderPage();
    expect(screen.getByRole('button', { name: /^back to hub choice$/i })).toBeInTheDocument();
  });

  it('drops the Portal sign-in when the Companion URL changes', async () => {
    sessionStorage.setItem('ci-hub.portalAuth', JSON.stringify({ token: 'AT', cookie: null, kind: 'oauth' }));
    renderPage();
    const urlField = screen.getByLabelText('Companion URL');
    await user.clear(urlField);
    await user.type(urlField, 'https://hub.example.test');
    await user.click(screen.getByRole('button', { name: /^save url$/i }));

    expect(sessionStorage.getItem('ci-hub.portalAuth')).toBeNull();
  });

  it('keeps the Portal sign-in when Save URL changes nothing', async () => {
    sessionStorage.setItem('ci-hub.portalAuth', JSON.stringify({ token: 'AT', cookie: null, kind: 'oauth' }));
    renderPage();
    await user.click(screen.getByRole('button', { name: /^save url$/i }));

    expect(sessionStorage.getItem('ci-hub.portalAuth')).not.toBeNull();
  });
});
