import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResourcesPage from '../resources-page';

/*
 * The page with its data hooks stubbed: which tab opens, the notice it raises from the same checks
 * the previous page used, and what changes for someone who doesn't manage the Hub.
 */

const access = vi.hoisted(() => ({ manageHub: true }));
const data = vi.hoisted(() => ({ peers: [] as Record<string, unknown>[] }));

const answered = (value: unknown) => ({ data: value, isPending: false, isError: false, dataUpdatedAt: Date.now() });

vi.mock('@/lib/hooks/use-hub-access', () => ({ useHubAccess: () => ({ manageHub: access.manageHub, isPending: false }) }));

vi.mock('@/modules/system/use-dashboard-data', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDashboardData: () => ({
    containers: answered({ sampledAt: new Date().toISOString(), apps: [], history: [], unattributedGpu: null, gpuVramSource: 'absent' }),
    pool: answered({
      enabled: true,
      localNode: { backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:1b'] }] },
      peers: data.peers,
      settings: { poolHealthPollSeconds: 30 },
    }),
    routingLog: answered({ entries: [], summary: { startedAt: new Date().toISOString() } }),
    inference: answered({ backends: [{ type: 'ollama', running: true, healthy: true }] }),
    memory: answered({}),
    residency: answered({ backends: [], residentCount: 0, sampledAt: new Date().toISOString() }),
    hardware: answered({ cpu: { cores: 8 }, ram: { totalMb: 16_384, availableMb: 8_192, usedMb: 8_192 } }),
    cloudProviders: answered([]),
    systemLoad: answered({ cpuLoad: 4, cpuCores: 8, diskUsed: 100, diskSize: 500, percentUsed: 20, memoryTotal: 16, memoryUsed: 8 }),
  }),
}));

vi.mock('../use-resources-data', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTelemetry: () => ({ points: [], bucketSeconds: 5, query: { isPending: false, isError: false } }),
  useDiskModels: () => ({ models: [], pending: false, failed: false }),
  useAppNames: () => new Map(),
}));

const unreachable = {
  id: 'p1',
  nodeFqdn: 'beta-1.capybara.ts.net',
  status: 'unreachable',
  enabled: true,
  direction: 'outbound',
  consecutiveFailures: 5,
  lastSeenAt: '2026-11-11 09:00:00',
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ResourcesPage />
    </MemoryRouter>,
  );
}

describe('Resources page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    access.manageHub = true;
    data.peers = [];
  });

  it('opens on Performance and on the tab the address names', () => {
    const { unmount } = renderAt('/resource-monitor');
    expect(screen.getByRole('tab', { name: 'Performance' }).getAttribute('aria-selected')).toBe('true');
    unmount();

    renderAt('/resource-monitor?tab=requests');
    expect(screen.getByRole('tab', { name: 'Requests' }).getAttribute('aria-selected')).toBe('true');
  });

  it('raises no notice when nothing is wrong', () => {
    renderAt('/resource-monitor');

    expect(screen.queryByTestId('resources-notice')).toBeNull();
  });

  it('says in words when a Hub in the pool cannot be reached, and goes there', () => {
    data.peers = [unreachable];
    renderAt('/resource-monitor');

    expect(screen.getByText("1 Hub in your pool can't be reached.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show pool' }));
    expect(screen.getByRole('tab', { name: 'AI pool' }).getAttribute('aria-selected')).toBe('true');
  });

  it('counts a Hub that is down and failing its probes once, and a second Hub failing probes too', () => {
    data.peers = [
      unreachable,
      { ...unreachable, id: 'p2', nodeFqdn: 'core-7.capybara.ts.net', status: 'connected', consecutiveFailures: 2 },
      { ...unreachable, id: 'p3', nodeFqdn: 'core-9.capybara.ts.net', status: 'unreachable', enabled: false },
    ];
    renderAt('/resource-monitor');

    expect(screen.getByText("2 Hubs in your pool can't be reached.")).toBeTruthy();
  });

  it("doesn't call a connected Hub that is only failing probes unreachable", () => {
    data.peers = [{ ...unreachable, status: 'connected', consecutiveFailures: 2 }];
    renderAt('/resource-monitor');

    expect(screen.getByText('1 Hub in your pool is failing its health checks.')).toBeTruthy();
    expect(screen.queryByText(/can't be reached/)).toBeNull();
  });

  it('shows a member the pool without the buttons that change it', () => {
    access.manageHub = false;
    renderAt('/resource-monitor?tab=pool');

    expect(screen.getByText('No other Hub has joined your pool')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add a Hub' })).toBeNull();
  });
});
