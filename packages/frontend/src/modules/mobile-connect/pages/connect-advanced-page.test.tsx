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
});
