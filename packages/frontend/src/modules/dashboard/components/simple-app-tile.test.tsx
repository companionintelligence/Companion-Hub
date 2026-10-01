import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { SimpleAppTile } from './simple-app-tile';

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock('@/modules/app/components/install-retry-button/install-retry-button', () => ({
  InstallRetryButton: () => <button type="button">retry</button>,
}));

describe('SimpleAppTile', () => {
  it('shows a top-right stopped power badge for stopped apps', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="stopped" />);

    expect(screen.getByTestId('app-stopped-badge')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('retry')).not.toBeInTheDocument();
  });

  it('shows the same stopped badge for legacy missing status', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="missing" />);

    expect(screen.getByTestId('app-stopped-badge')).toBeInTheDocument();
  });

  it('does not show a stopped badge while running', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="running" />);

    expect(screen.queryByTestId('app-stopped-badge')).not.toBeInTheDocument();
  });

  it('badges a running app whose env is waiting on a restart', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="running" pendingRestart />);

    expect(screen.getByTestId('app-pending-restart-badge')).toBeInTheDocument();
  });

  it('names the domain that stays dark until the restart happens', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="running" pendingRestart customDomainAwaitingRestart="wp.example.com" />);

    // The generic "configuration has changed" does not tell an operator their
    // customer's domain is down, which is the only reason this badge is urgent.
    expect(screen.getByTestId('app-pending-restart-badge')).toHaveAttribute('title', expect.stringContaining('wp.example.com'));
  });

  it('does not ask a stopped app to restart', () => {
    // `start-app-command` regenerates the env on the way up, so the restart this
    // badge asks for is already scheduled. Asking for it anyway is how a badge
    // earns being ignored.
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="stopped" pendingRestart />);

    expect(screen.queryByTestId('app-pending-restart-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-stopped-badge')).toBeInTheDocument();
  });

  it('stays quiet while the app is still installing', () => {
    render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status="installing" isInstalling pendingRestart />);

    expect(screen.queryByTestId('app-pending-restart-badge')).not.toBeInTheDocument();
  });

  // The remedy is already under way (or the app is being deleted). Asking for a
  // restart mid-restart is the same "pointless work" the stopped case avoids, and
  // listing only the statuses to EXCLUDE is what let these eight through.
  it.each(['restarting', 'starting', 'stopping', 'uninstalling', 'updating', 'resetting', 'backing_up', 'restoring'] as const)(
    'does not ask an app that is %s to restart',
    (status) => {
      render(<SimpleAppTile name="Demo" urn="demo:ci-marketplace" status={status} pendingRestart customDomainAwaitingRestart="wp.example.com" />);

      expect(screen.queryByTestId('app-pending-restart-badge')).not.toBeInTheDocument();
    },
  );
});
