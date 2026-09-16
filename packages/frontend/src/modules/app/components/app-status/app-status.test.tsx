import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { AppStatus, getAppStatusPresentation, isCompletedOneShotContainer, isConcerningContainer } from './app-status';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (key === 'APP_STATUS_INSTALLING' ? 'Installing' : (fallback ?? key)),
  }),
}));

const runningContainer = {
  containerId: 'app',
  name: 'test-app',
  state: 'running',
  status: 'Up 2 minutes',
  health: null,
  exitCode: null,
  cpuPercent: 1,
  memoryUsageBytes: 0,
  memoryLimitBytes: 0,
};

/** A fully healthy snapshot — the baseline the public-route cases build on. */
function healthyRuntime(overrides: Partial<AppRuntimeHealth> = {}): AppRuntimeHealth {
  return {
    appUrn: 'test-app:community',
    appName: 'test-app',
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
    gpuVramMb: null,
    sampledAt: new Date().toISOString(),
    containers: [runningContainer],
    ...overrides,
  };
}

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
      gpuVramMb: null,
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
      gpuVramMb: null,
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

  it('uses Docker status text when an older runtime-health payload omits exitCode', () => {
    const presentation = getAppStatusPresentation('running', {
      ...healthyRuntime(),
      appUrn: 'ci-memory:ci-marketplace',
      appName: 'ci-memory',
      containers: [
        runningContainer,
        {
          containerId: 'setup',
          name: 'ci-memory_ci-marketplace-setup-secrets-1',
          state: 'exited',
          status: 'Exited (0) 9 minutes ago',
          health: null,
          cpuPercent: 0,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
        },
      ],
    });

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING');
    expect(presentation.tone).toBe('success');
  });

  it('folds a still-propagating public route into the pill instead of a plain green Running', () => {
    const presentation = getAppStatusPresentation('running', healthyRuntime(), { propagating: true, detail: 'DNS propagating...' });

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING_PROPAGATING');
    expect(presentation.fallbackLabel).toBe('Running (DNS propagating...)');
    expect(presentation.tone).toBe('warning');
    expect(presentation.animate).toBe(true);
    expect(presentation.detail).toBe('DNS propagating...');
  });

  it('falls back to generic propagation copy when the probe gave no reason', () => {
    const presentation = getAppStatusPresentation('running', healthyRuntime(), { propagating: true, detail: null });

    expect(presentation.detail).toBe('The app is running. Its public web address is still coming up.');
  });

  it('keeps a plain green Running when runtime stats have not loaded yet', () => {
    const presentation = getAppStatusPresentation('running');

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING');
    expect(presentation.tone).toBe('success');
  });

  it('reports running when every long-lived ci-memory container is up', () => {
    const longLived = ['gateway', 'summary-service', 'hbpe-service', 'api', 'orchestrator', 'object-store', 'database'].map((name, index) => ({
      containerId: String(index),
      name: `ci-memory_ci-marketplace-${name}-1`,
      state: 'running',
      status: 'Up 2 minutes',
      health: name === 'database' ? 'healthy' : null,
      exitCode: null,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
    }));

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
      gpuVramMb: null,
      sampledAt: new Date().toISOString(),
      containers: [
        ...longLived,
        {
          containerId: 'migrate',
          name: 'ci-memory_ci-marketplace-migrate-database-1',
          state: 'exited',
          status: 'Exited (0) 2 minutes ago',
          health: null,
          exitCode: 0,
          cpuPercent: 0,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
        },
      ],
    });

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING');
    expect(presentation.tone).toBe('success');
  });

  it('keeps a plain green Running when the route is not propagating', () => {
    const presentation = getAppStatusPresentation('running', healthyRuntime(), { propagating: false, detail: null });

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING');
    expect(presentation.tone).toBe('success');
  });

  it('is unchanged when no public-route information is supplied', () => {
    const presentation = getAppStatusPresentation('running', healthyRuntime());

    expect(presentation.labelKey).toBe('APP_STATUS_RUNNING');
    expect(presentation.tone).toBe('success');
  });

  it('lets container health outrank the public route', () => {
    // A degraded app is a more urgent (and more accurate) thing to say than
    // "its DNS is propagating", so the container-level branches win.
    const degraded = getAppStatusPresentation('running', healthyRuntime({ degraded: true }), { propagating: true, detail: 'DNS propagating...' });
    expect(degraded.labelKey).toBe('APP_STATUS_DEGRADED');

    const initializing = getAppStatusPresentation(
      'running',
      healthyRuntime({ containers: [{ ...runningContainer, state: 'created', health: 'starting' }] }),
      { propagating: true, detail: 'DNS propagating...' },
    );
    expect(initializing.labelKey).toBe('APP_STATUS_INITIALIZING');
  });

  it('ignores propagation for statuses other than running', () => {
    const presentation = getAppStatusPresentation('stopped', null, { propagating: true, detail: 'DNS propagating...' });

    expect(presentation.labelKey).toBe('APP_STATUS_STOPPED');
    expect(presentation.tone).toBe('danger');
  });

  it('treats legacy missing status as Stopped', () => {
    const presentation = getAppStatusPresentation('missing');

    expect(presentation.labelKey).toBe('APP_STATUS_STOPPED');
    expect(presentation.fallbackLabel).toBe('Stopped');
    expect(presentation.tone).toBe('danger');
  });

  it('renders a Stopped pill for legacy missing status', () => {
    render(<AppStatus status="missing" variant="pill" />);

    expect(screen.getByTestId('app-status-pill')).toHaveTextContent('Stopped');
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
      gpuVramMb: null,
      sampledAt: new Date().toISOString(),
      containers: [failedSetup],
    });

    expect(presentation.fallbackLabel).toBe('Needs attention');
    expect(presentation.tone).toBe('danger');
  });

  it('detects a failed one-shot job from Docker status text when exitCode is omitted', () => {
    const failedSetup = {
      containerId: 'migrate',
      name: 'ci-memory-migrate-database',
      state: 'exited',
      status: 'Exited (1) 1 minute ago',
      health: null,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
    };

    expect(isCompletedOneShotContainer(failedSetup)).toBe(false);
    expect(isConcerningContainer(failedSetup)).toBe(true);
  });
});
