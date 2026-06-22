import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AppStatus, getAppStatusPresentation } from './app-status';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (key === 'APP_STATUS_INSTALLING' ? 'Installing' : (fallback ?? key)),
  }),
}));

describe('AppStatus', () => {
  it('renders the translated installing label', () => {
    render(<AppStatus status="installing" />);

    expect(screen.getByText('Installing')).toBeInTheDocument();
  });

  it('falls back to a humanized label when a status key is missing', () => {
    render(<AppStatus status={'install_failed' as never} />);

    expect(screen.getByText('Install failed')).toBeInTheDocument();
  });

  it('derives initializing when a running app still has transitional containers', () => {
    const presentation = getAppStatusPresentation('running', {
      appUrn: 'demo:store',
      appName: 'demo',
      status: 'running',
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      highCpu: false,
      sustainedHighCpu: false,
      responsive: true,
      degraded: false,
      forceStopEligible: false,
      reason: null,
      cpuLimit: null,
      usesDefaultCpuLimit: false,
      sampledAt: new Date().toISOString(),
      containers: [
        {
          containerId: '1',
          name: 'demo',
          state: 'created',
          status: 'Created',
          health: 'starting',
          cpuPercent: 0,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
        },
      ],
    });

    expect(presentation.fallbackLabel).toBe('Initializing');
    expect(presentation.tone).toBe('warning');
  });
});
