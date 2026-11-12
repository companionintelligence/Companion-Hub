import type { PoolNodeCard } from '@/modules/system/pool-node-series';
import type { PoolReach } from '@/modules/system/use-dashboard-data';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PoolTab } from '../pool-tab';

const card = (key: string, status: string, local = false): PoolNodeCard =>
  ({
    key,
    label: key,
    local,
    fqdn: local ? null : `${key}.capybara.ts.net`,
    direction: local ? null : 'outbound',
    status,
    hardwareTier: 'high',
    backends: [{ type: 'ollama', healthy: true, models: 4 }],
    models: status === 'connected' || local ? 4 : null,
    inFlight: 0,
    inFlightMeaning: local ? 'local-engines' : 'forwarded-by-us',
    peerReportedInFlight: null,
    pressureBand: null,
    pressureSource: null,
    containers: null,
    lastSeenAt: '2026-11-11T09:00:00Z',
    consecutiveFailures: status === 'unreachable' ? 83 : 0,
    capabilitiesError: null,
    firstByte: null,
    decode: null,
  }) as PoolNodeCard;

const reach: PoolReach = { connected: 1, unreachable: 1, probeFailures: 0, reachableModels: 4, exclusiveModels: 0, peerInFlight: null };
const ready = { pending: false, failed: false };
const NOW = Date.parse('2026-11-12T05:00:00Z');

function renderTab(props: Partial<Parameters<typeof PoolTab>[0]> = {}) {
  return render(
    <MemoryRouter>
      <PoolTab
        pool={{ enabled: true }}
        state={ready}
        cards={[card('local', 'local', true), card('beta-1', 'unreachable'), card('core-14', 'connected')]}
        reach={reach}
        models={[{ model: 'gemma3:1b', nodes: ['This Hub', 'core-14'] }]}
        manageHub
        now={NOW}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('AI pool tab', () => {
  it('lists this Hub first and opens a peer onto its details', () => {
    renderTab();

    const rows = screen.getAllByTestId('resources-pool-row');
    expect(rows[0]?.textContent).toContain('This Hub');
    fireEvent.click(screen.getByRole('button', { name: 'Show details for beta-1' }));
    expect(screen.getByText('beta-1.capybara.ts.net')).toBeTruthy();
    expect(screen.getByText('83')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open its Resources page/ }).getAttribute('href')).toBe(
      'https://beta-1.capybara.ts.net/resource-monitor',
    );
  });

  it('offers pool settings only to someone who manages the Hub', () => {
    const { unmount } = renderTab();
    expect(screen.getByRole('link', { name: 'Pool settings' })).toBeTruthy();
    unmount();

    renderTab({ manageHub: false });
    expect(screen.queryByRole('link', { name: 'Pool settings' })).toBeNull();
  });

  it('invites a manager to add a Hub when nothing is paired, and tells a member who can', () => {
    const { unmount } = renderTab({ cards: [card('local', 'local', true)] });
    expect(screen.getByText('No other Hub has joined your pool')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a Hub' })).toBeTruthy();
    unmount();

    renderTab({ cards: [card('local', 'local', true)], manageHub: false });
    expect(screen.queryByRole('link', { name: 'Add a Hub' })).toBeNull();
    expect(screen.getByText(/When the person who manages this Hub/)).toBeTruthy();
  });

  it('says the pool failed to load instead of showing an empty pool', () => {
    renderTab({ state: { pending: false, failed: true }, cards: [] });

    expect(screen.getByText(/Couldn't load the pool/)).toBeTruthy();
    expect(screen.queryByTestId('resources-pool-empty')).toBeNull();
  });
});
