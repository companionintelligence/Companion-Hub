import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AppStatus, getAppStatusPresentation, isCompletedOneShotContainer, isConcerningContainer } from './app-status';

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

  it('treats successfully exited setup containers as healthy for multi-service apps', () => {
    const setupContainer = {
      containerId: 'setup',
      name: 'ci-memory-setup-secrets',
      state: 'exited',
      status: 'Exited (0) 2 minutes ago',
      health: null,
      exitCode: 0,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
    };

    expect(isCompletedOneShotContainer(setupContainer)).toBe(true);
    expect(isConcerningContainer(setupContainer)).toBe(false);

    const presentation = getAppStatusPresentation('running', {
      appUrn: 'ci-memory:ci-marketplace',
      appName: 'ci-memory',
      status: 'running',
      cpuPercent: 1,
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
        setupContainer,
        {
          containerId: 'gateway',
          name: 'ci-memory-gateway',
          state: 'running',
          status: 'Up 2 minutes',
          health: null,
          exitCode: null,
          cpuPercent: 1,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
        },
      ],
    });

    expect(presentation.fallbackLabel).toBe('Running');
    expect(presentation.tone).toBe('success');
  });

  it('flags exited containers with a non-zero exit code', () => {
    const failedSetup = {
      containerId: 'migrate',
      name: 'ci-memory-migrate-database',
      state: 'exited',
      status: 'Exited (1) 1 minute ago',
      health: null,
      exitCode: 1,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
    };

    expect(isConcerningContainer(failedSetup)).toBe(true);

    const presentation = getAppStatusPresentation('running', {
      appUrn: 'ci-memory:ci-marketplace',
      appName: 'ci-memory',
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
      containers: [failedSetup],
    });

    expect(presentation.fallbackLabel).toBe('Needs attention');
    expect(presentation.tone).toBe('danger');
  });
});
