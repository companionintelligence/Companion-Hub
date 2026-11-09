import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useRegistrationStatus } = vi.hoisted(() => ({ useRegistrationStatus: vi.fn() }));

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => useRegistrationStatus(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PortalUnreachableBanner } from './portal-unreachable-banner';

const withStatus = (phase: string, degradedReasons: string[] = []) =>
  useRegistrationStatus.mockReturnValue({ data: { phase, registered: true, degradedReasons } });

describe('PortalUnreachableBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says so when check-ins to the Portal keep failing', () => {
    withStatus('degraded', ['cloud_validation_failed']);

    render(<PortalUnreachableBanner />);

    const banner = screen.getByTestId('portal-unreachable-banner');
    expect(banner).toHaveTextContent('PORTAL_UNREACHABLE_BANNER_TITLE');
    expect(banner).toHaveTextContent('PORTAL_UNREACHABLE_BANNER_MESSAGE');
    expect(banner).toHaveAttribute('role', 'status');
  });

  it.each([
    ['a Hub in good standing', 'publicly_ready', []],
    ['a Hub without a public address yet', 'locally_ready', []],
    ['a Hub whose status has not loaded', undefined, []],
    ['a lost tunnel token, which has its own banner', 'degraded', ['tunnel_token_missing']],
    ['an unreachable tunnel, where the Portal still answers', 'degraded', ['tunnel_unreachable']],
    ['a refused device key, where the Portal did answer', 'degraded', ['portal_rejected']],
  ])('stays away for %s', (_name, phase, reasons) => {
    if (phase) {
      withStatus(phase, reasons);
    } else {
      useRegistrationStatus.mockReturnValue({ data: undefined });
    }

    render(<PortalUnreachableBanner />);

    expect(screen.queryByTestId('portal-unreachable-banner')).not.toBeInTheDocument();
  });
});
