import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useRegistrationStatus } = vi.hoisted(() => ({ useRegistrationStatus: vi.fn() }));

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => useRegistrationStatus(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PortalConnectionBanner } from './portal-connection-banner';

const withStatus = (phase: string, degradedReasons: string[] = []) =>
  useRegistrationStatus.mockReturnValue({ data: { phase, registered: true, degradedReasons } });

describe('PortalConnectionBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says so when check-ins to the Portal keep failing', () => {
    withStatus('degraded', ['cloud_validation_failed']);

    render(<PortalConnectionBanner />);

    const banner = screen.getByTestId('portal-connection-banner');
    expect(banner).toHaveTextContent('PORTAL_CHECK_IN_FAILING_BANNER_TITLE');
    expect(banner).toHaveTextContent('PORTAL_CHECK_IN_FAILING_BANNER_MESSAGE');
    expect(banner).not.toHaveTextContent('PORTAL_REJECTED_BANNER_TITLE');
    expect(banner).toHaveAttribute('role', 'status');
  });

  // Failing check-ins turn into this reason after ten minutes of refusals. A notice that vanished
  // there would read as the Hub having recovered, at the moment only pairing again can help.
  it('names the way out when the Portal keeps refusing the device key', () => {
    withStatus('degraded', ['portal_rejected']);

    render(<PortalConnectionBanner />);

    const banner = screen.getByTestId('portal-connection-banner');
    expect(banner).toHaveTextContent('PORTAL_REJECTED_BANNER_TITLE');
    expect(banner).toHaveTextContent('PORTAL_REJECTED_BANNER_MESSAGE');
    expect(banner).not.toHaveTextContent('PORTAL_CHECK_IN_FAILING_BANNER_TITLE');
  });

  it.each([
    ['a Hub in good standing', 'publicly_ready', []],
    ['a Hub without a public address yet', 'locally_ready', []],
    ['a Hub whose status has not loaded', undefined, []],
    ['a lost tunnel token, which has its own banner', 'degraded', ['tunnel_token_missing']],
    ['an unreachable tunnel, where the Portal still answers', 'degraded', ['tunnel_unreachable']],
  ])('stays away for %s', (_name, phase, reasons) => {
    if (phase) {
      withStatus(phase, reasons);
    } else {
      useRegistrationStatus.mockReturnValue({ data: undefined });
    }

    render(<PortalConnectionBanner />);

    expect(screen.queryByTestId('portal-connection-banner')).not.toBeInTheDocument();
  });
});
