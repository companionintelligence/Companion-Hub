import { act, fireEvent, render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpForm } from './otp-form';

const { mockUseMutation, refreshAppContext } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  refreshAppContext: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => mockUseMutation(options),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getTotpUriMutation: vi.fn(() => ({})),
  setupTotpMutation: vi.fn(() => ({})),
  disableTotpMutation: vi.fn(() => ({})),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ refreshAppContext }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const SECRET_KEY = 'JBSWY3DPEHPK3PXP';
const SECRET_URI = `otpauth://totp/CI-Hub:admin@example.com?secret=${SECRET_KEY}&issuer=CI-Hub`;

describe('OtpForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  /** Render, then drive the `getTotpUri` success handler so the setup panel appears. */
  function renderWithSecret() {
    render(<OtpForm totpEnabled={false} />);
    const options = mockUseMutation.mock.calls[0]?.[0] as { onSuccess: (data: { key: string; uri: string }) => void };

    act(() => {
      options.onSuccess({ key: SECRET_KEY, uri: SECRET_URI });
    });
  }

  it('does not render the second factor until it is asked for', () => {
    // Regression: the base32 secret used to render unconditionally in a readOnly
    // input beside the QR. One screenshot or screen share of this panel is a
    // permanent second-factor compromise — unlike a copied string, neither the
    // code nor the key re-encodes away.
    renderWithSecret();

    expect(screen.queryByText(SECRET_KEY)).not.toBeInTheDocument();
    // ...and not as a form value either, which is how it used to leak
    expect(screen.queryByDisplayValue(SECRET_KEY)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'COMMON_QR_SHOW_CODE' })).toBeInTheDocument();
  });

  it('reveals the key on request so a camera that will not focus is not a dead end', () => {
    // arrange
    renderWithSecret();

    // act
    fireEvent.click(screen.getByRole('button', { name: 'COMMON_QR_SHOW_CODE' }));

    // assert — the manual-entry key, not the otpauth URI: the key is what a person
    // can actually type into an authenticator
    expect(screen.getByText(SECRET_KEY)).toBeInTheDocument();
  });

  it('keeps both setup instructions on the panel', () => {
    renderWithSecret();

    expect(screen.getByText('SETTINGS_SECURITY_SCAN_QR_CODE')).toBeInTheDocument();
    expect(screen.getByText('SETTINGS_SECURITY_ENTER_KEY_MANUALLY')).toBeInTheDocument();
  });
});
