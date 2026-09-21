import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppReadiness } from '@/lib/app-runtime-monitor';
import { AppReadinessBadge, AppReadinessChecksCard, failingReadinessChecks } from './app-readiness';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** The Hermes sample from CI-Hub#1556 after the backend normaliser: model and gateway failing, config passing with a detail. */
function degradedReadiness(overrides: Partial<AppReadiness> = {}): AppReadiness {
  return {
    status: 'degraded',
    checks: {
      state_db: { status: 'ok' },
      config: { status: 'ok', detail: 'using defaults' },
      model: { status: 'degraded' },
      gateway: { status: 'degraded' },
      session_store: { status: 'unavailable', detail: 'session store gone' },
    },
    busy: false,
    drainable: false,
    sampledAt: '2026-09-21T12:00:00.000Z',
    ...overrides,
  };
}

describe('failingReadinessChecks', () => {
  it('keeps every check whose status is not ok, in the order the app listed them', () => {
    expect(failingReadinessChecks(degradedReadiness()).map(([name]) => name)).toEqual(['model', 'gateway', 'session_store']);
  });
});

describe('AppReadinessBadge', () => {
  it('renders nothing when the app declares no readiness endpoint (readiness is null)', () => {
    const { container } = render(<AppReadinessBadge readiness={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before runtime health has loaded', () => {
    const { container } = render(<AppReadinessBadge readiness={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "ready" for an ok sample', () => {
    render(<AppReadinessBadge readiness={degradedReadiness({ status: 'ok', checks: { model: { status: 'ok' } } })} />);
    expect(screen.getByText('APP_READINESS_BADGE_OK')).toBeInTheDocument();
  });

  it('shows "degraded" and names the failing checks in the tooltip', () => {
    render(<AppReadinessBadge readiness={degradedReadiness()} />);
    const pill = screen.getByText('APP_READINESS_BADGE_DEGRADED');
    expect(pill).toBeInTheDocument();
    expect(pill.closest('span')).toHaveAttribute('title', 'model, gateway, session_store');
  });

  it('shows "unknown" for a missed probe, and never "degraded"', () => {
    render(<AppReadinessBadge readiness={{ status: 'unknown', checks: {}, busy: null, drainable: null, sampledAt: '2026-09-21T12:00:00.000Z' }} />);
    expect(screen.getByText('APP_READINESS_BADGE_UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('APP_READINESS_BADGE_DEGRADED')).not.toBeInTheDocument();
  });
});

describe('AppReadinessChecksCard', () => {
  it('renders nothing when there is no readiness', () => {
    const { container } = render(<AppReadinessChecksCard readiness={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every check passes, or when an unknown sample carries no checks', () => {
    const ok = render(<AppReadinessChecksCard readiness={degradedReadiness({ status: 'ok', checks: { model: { status: 'ok' } } })} />);
    expect(ok.container).toBeEmptyDOMElement();
    const unknown = render(
      <AppReadinessChecksCard readiness={{ status: 'unknown', checks: {}, busy: null, drainable: null, sampledAt: '2026-09-21T12:00:00.000Z' }} />,
    );
    expect(unknown.container).toBeEmptyDOMElement();
  });

  it('lists the failing checks by name with the app status and detail, and omits the passing ones', () => {
    render(<AppReadinessChecksCard readiness={degradedReadiness()} />);

    expect(screen.getByTestId('app-readiness-checks')).toBeInTheDocument();
    expect(screen.getByText('model')).toBeInTheDocument();
    expect(screen.getByText('gateway')).toBeInTheDocument();
    expect(screen.getByText('session_store')).toBeInTheDocument();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('session store gone')).toBeInTheDocument();
    expect(screen.getAllByText('degraded')).toHaveLength(2);

    expect(screen.queryByText('state_db')).not.toBeInTheDocument();
    expect(screen.queryByText('config')).not.toBeInTheDocument();
    expect(screen.queryByText('using defaults')).not.toBeInTheDocument();
  });

  it('still lists failing checks when the overall status is unknown, since the app named them', () => {
    // A top-level status this build does not know is `unknown`; the checks are still worth showing.
    render(<AppReadinessChecksCard readiness={degradedReadiness({ status: 'unknown' })} />);
    expect(screen.getByText('model')).toBeInTheDocument();
  });
});
