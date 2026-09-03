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
});
