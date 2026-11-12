import type { OwnInference } from '@/modules/system/pool-node-series';
import type { RoutingLogEntry } from '@/modules/system/use-dashboard-data';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequestsTab, requestRoute } from '../requests-tab';

const NOW = Date.parse('2026-11-12T05:00:00Z');
const hubName = (node: string) => node.split('.')[0] ?? node;

const entry = (direction: string, node: string | null, outcome = 'served'): RoutingLogEntry => ({
  at: '2026-11-12T04:50:00Z',
  direction,
  node,
  outcome,
  model: 'qwen3.5:9b',
  durationMs: 6200,
});

const own: OwnInference = {
  requests: 0,
  served: 0,
  failed: 0,
  clientClosed: 0,
  refused: 0,
  overBudget: 0,
  pending: 0,
  failovers: 0,
  usageReported: 0,
  promptTokens: 0,
  completionTokens: 0,
  firstByte: null,
  models: [],
  modelCount: 0,
};

describe('Requests tab', () => {
  it('names where a request came from, and the other Hub only when one ran it', () => {
    expect(requestRoute(entry('outbound', 'local'), hubName, 'This Hub')).toEqual({ from: 'This Hub', ranOn: null });
    expect(requestRoute(entry('outbound', 'beta-max.capybara.ts.net'), hubName, 'This Hub')).toEqual({ from: 'This Hub', ranOn: 'beta-max' });
    expect(requestRoute(entry('inbound', 'beta-max.capybara.ts.net'), hubName, 'This Hub')).toEqual({ from: 'beta-max', ranOn: null });
    expect(requestRoute(entry('outbound', null, 'failed'), hubName, 'This Hub')).toEqual({ from: 'This Hub', ranOn: null });
  });

  it('lists the log without a served-by column and says where a forwarded request ran', () => {
    render(
      <RequestsTab
        entries={[entry('inbound', 'beta-max.capybara.ts.net'), entry('outbound', 'local'), entry('outbound', 'core-14.capybara.ts.net')]}
        state={{ pending: false, failed: false }}
        buckets={[]}
        own={own}
        hubName={hubName}
        unlogged={false}
        now={NOW}
      />,
    );

    const rows = screen.getAllByTestId('resources-request-row');
    expect(rows).toHaveLength(3);
    expect(screen.queryByRole('columnheader', { name: 'Served by' })).toBeNull();
    expect(rows[0]?.textContent).toContain('beta-max');
    expect(rows[1]?.textContent).toContain('Served');
    expect(rows[1]?.textContent).not.toContain('Served by');
    expect(rows[2]?.textContent).toContain('Served by core-14');
    expect(screen.getByText('No AI requests in the last 30 minutes.')).toBeTruthy();
  });

  it('says so when the log could not be read', () => {
    render(<RequestsTab entries={[]} state={{ pending: false, failed: true }} buckets={[]} own={own} hubName={hubName} unlogged={false} now={NOW} />);

    expect(screen.getAllByText(/Couldn't load the request log/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('resources-request-row')).toBeNull();
  });
});
