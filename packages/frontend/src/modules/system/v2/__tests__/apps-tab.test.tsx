import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppsTab, serviceName, shade } from '../apps-tab';

const container = (name: string, state = 'running', exitCode: number | null = null, memoryUsageBytes = 100 * 1024 * 1024) => ({
  containerId: name,
  name,
  state,
  status: state === 'running' ? 'Up 3 days' : 'Exited (0) 3 days ago',
  health: null,
  exitCode,
  cpuPercent: 1,
  memoryUsageBytes,
  memoryLimitBytes: 0,
});

const app = (urn: string, cpuPercent: number, memoryGb: number, containers = [container(`${urn.split(':')[0]}-1`)]): AppRuntimeHealth => ({
  appUrn: urn,
  appName: urn.split(':')[0] ?? urn,
  status: 'running',
  cpuPercent,
  memoryUsageBytes: memoryGb * 1024 ** 3,
  memoryLimitBytes: 0,
  highCpu: false,
  sustainedHighCpu: false,
  responsive: true,
  degraded: false,
  forceStopEligible: false,
  reason: null,
  cpuLimit: null,
  usesDefaultCpuLimit: true,
  sampledAt: '2026-11-12T05:00:00Z',
  containers,
  gpuVramMb: null,
  readiness: null,
});

const memoryApp = app('ci-memory:ci-marketplace', 5.8, 0.9, [
  container('ci-memory_ci-marketplace-api-1'),
  container('ci-memory_ci-marketplace-database-1'),
  container('ci-memory_ci-marketplace-migrate-database-1', 'exited', 0, 0),
]);
const comfy = app('comfyui:ci-marketplace', 640, 24);
const names = new Map([['ci-memory:ci-marketplace', 'Companion Memory']]);
const appName = (urn: string, fallback: string) => names.get(urn) ?? fallback;
const ready = { pending: false, failed: false };

function renderTab(apps = [memoryApp, comfy], state = ready) {
  return render(<AppsTab apps={apps} history={[]} state={state} cores={32} ramTotalMb={128 * 1024} appName={appName} />);
}

describe('Apps tab', () => {
  it('names apps the way Home does, and falls back to the slug', () => {
    renderTab();

    expect(screen.getByText('Companion Memory')).toBeTruthy();
    expect(screen.getByText('comfyui')).toBeTruthy();
  });

  it('shows CPU as a share of the whole machine, totalled over the column', () => {
    renderTab();

    // 640% of one core on a 32-core machine is 20% of the machine, and with 5.8% of a core more the
    // column total rounds to 20% too.
    const comfyRow = screen.getAllByTestId('resources-app-row').find((row) => row.textContent?.includes('comfyui'));
    expect(comfyRow?.textContent).toContain('20%');
    const header = screen.getAllByRole('columnheader').find((cell) => cell.textContent?.includes('CPU'));
    expect(header?.textContent).toContain('20%');
  });

  it('sorts by memory first and flips on a second click', () => {
    renderTab();
    const firstRowName = () => within(screen.getAllByTestId('resources-app-row')[0] as HTMLElement).getByText(/comfyui|Companion Memory/).textContent;

    expect(firstRowName()).toBe('comfyui');
    fireEvent.click(screen.getByRole('button', { name: /^Memory/ }));
    expect(firstRowName()).toBe('Companion Memory');
  });

  it('opens a row onto its services and folds finished setup containers into one line', () => {
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Show the containers of Companion Memory' }));

    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.getByText('database')).toBeTruthy();
    expect(screen.queryByText('migrate-database')).toBeNull();
    expect(screen.getByText('1 setup container finished and stopped')).toBeTruthy();
  });

  it('says the figures failed rather than showing an empty table', () => {
    renderTab([], { pending: false, failed: true });

    expect(screen.getByText(/Couldn't load the apps' figures/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shades only real load', () => {
    expect(shade(0.2)).toBeUndefined();
    expect(shade(3)).toContain('var(--primary) 7%');
    expect(shade(70)).toContain('var(--warning)');
  });

  it('names a container by its service', () => {
    expect(serviceName('ci-memory:ci-marketplace', 'ci-memory_ci-marketplace-summary-service-1')).toBe('summary-service');
    expect(serviceName('ci-hub:system', 'ci-hub-db')).toBe('ci-hub-db');
  });
});
