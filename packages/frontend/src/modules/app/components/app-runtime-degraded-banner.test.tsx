import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { AppRuntimeDegradedBanner } from './app-runtime-degraded-banner';

const degraded = {
  appName: 'cpu-hog',
  degraded: true,
  reason: 'The app accepted a connection on port 80 but did not answer within 5 seconds.',
} as AppRuntimeHealth;

describe('AppRuntimeDegradedBanner', () => {
  it('draws the warning box the Hub uses for its other warning banners', () => {
    render(<AppRuntimeDegradedBanner runtimeHealth={degraded} />);

    const banner = screen.getByRole('alert');
    // The shared warning box of `Alert`, the one TunnelStatusBanner draws.
    expect(banner).toHaveClass('rounded-lg', 'border', 'border-warning/30', 'bg-warning/10', 'px-4', 'py-3');
    expect(screen.getByRole('heading', { name: 'Hub is degraded by cpu-hog' })).toHaveClass('font-semibold', 'text-[color:var(--alert-heading)]');
    expect(screen.getByText(degraded.reason as string)).toHaveClass('[.alert-heading+&]:text-muted-foreground');
  });

  it('says why the Hub calls the app degraded, or the general reason when it has none', () => {
    render(<AppRuntimeDegradedBanner runtimeHealth={{ ...degraded, reason: null }} />);

    expect(screen.getByText(/This app is unresponsive while consuming sustained high CPU/)).toBeInTheDocument();
  });

  it('shows nothing while the app is not degraded', () => {
    const { container } = render(<AppRuntimeDegradedBanner runtimeHealth={{ ...degraded, degraded: false }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
