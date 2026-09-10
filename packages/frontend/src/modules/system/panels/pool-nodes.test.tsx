import { EMPTY_SAMPLE_WINDOW, type PoolNodeCard } from '@/modules/system/pool-node-series';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PoolNodes } from './pool-nodes';

/*
 * The node table, and the two things the collapse could plausibly break.
 *
 * ONE: nothing may become unreachable. The card is reused verbatim as the expanded row precisely
 * so that every column dropped below a breakpoint is still one click away, and a regression here
 * would silently delete information rather than fail loudly.
 *
 * TWO: the absence-vs-zero contract has to survive the move from card to cell. A peer that
 * reported no in-flight counter and no container rollup told us nothing; rendering either as 0
 * would state something the peer never sent, and the table's cells are the smallest, quietest
 * place on the page for that to go unnoticed.
 */

const READY = { pending: false, failed: false };

function card(overrides: Partial<PoolNodeCard> & { key: string; label: string }): PoolNodeCard {
  return {
    local: false,
    fqdn: `${overrides.key}.capybara-ulmer.ts.net`,
    direction: 'inbound',
    status: 'connected',
    hardwareTier: 'high',
    backends: [{ type: 'ollama', healthy: true, models: 3 }],
    models: 3,
    inFlight: 0,
    inFlightMeaning: 'forwarded-by-us',
    peerReportedInFlight: null,
    pressureBand: null,
    pressureSource: null,
    containers: null,
    lastSeenAt: null,
    consecutiveFailures: null,
    capabilitiesError: null,
    ...overrides,
  };
}

describe('PoolNodes', () => {
  it('collapses the card into a row and gives it back on click', async () => {
    const user = userEvent.setup();
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const toggle = screen.getByRole('button', { name: 'core-2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // "Models held" is a card readout and exists nowhere in the row.
    expect(screen.queryByText('Models held')).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Models held')).toBeTruthy();
    expect(screen.getByText('core-2.capybara-ulmer.ts.net')).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByText('Models held')).toBeNull();
  });

  it('opens from a click anywhere on the row, not only on the chevron', () => {
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const row = document.querySelector('tr[data-node="core-2"]') as HTMLElement;
    fireEvent.click(row);

    expect(screen.getByRole('button', { name: 'core-2' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens each node independently rather than as one accordion', async () => {
    const user = userEvent.setup();
    render(
      <PoolNodes
        cards={[card({ key: 'core-2', label: 'core-2' }), card({ key: 'core-7', label: 'core-7' })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'core-2' }));
    await user.click(screen.getByRole('button', { name: 'core-7' }));

    expect(screen.getByRole('button', { name: 'core-2' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'core-7' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders an unreported counter and an unreported rollup as absence, never as zero', () => {
    render(
      <PoolNodes
        cards={[card({ key: 'beta-red', label: 'beta-red', inFlight: null, containers: null })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    const row = document.querySelector('tr[data-node="beta-red"]') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim());

    expect(cells).toContain('—');
    expect(cells).toContain('not reported');
    expect(cells).not.toContain('0');
    expect(cells).not.toContain('0/0');
  });

  it('still separates a failed pool fetch from an empty pool', () => {
    const failed = render(<PoolNodes cards={[]} window={EMPTY_SAMPLE_WINDOW} state={{ pending: false, failed: true }} />);
    expect(failed.container.querySelector('table')).toBeNull();
    expect(failed.container.textContent).not.toContain('No nodes to show');

    const empty = render(<PoolNodes cards={[]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);
    expect(empty.container.textContent).toContain('No nodes to show');
  });

  it('drops a header and its cells together, so the table can never shift by one column', () => {
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const headers = [...document.querySelectorAll('thead th')];
    const cells = [...document.querySelectorAll('tbody tr[data-node] td')];
    expect(headers).toHaveLength(cells.length);

    /*
     * Token-wise, not a substring match on the whole class string: `cn` preserves author order, so
     * a cell written as "hidden text-muted-foreground sm:table-cell" and a header written as
     * "hidden sm:table-cell" describe the SAME breakpoint. What must agree is the pair of tokens,
     * not their spelling.
     */
    const breakpointOf = (element: Element) => {
      const classes = element.className.split(/\s+/);
      if (!classes.includes('hidden')) return 'always';

      return classes.find((name) => /^@?(sm|md|lg|xl|2xl|3xl):table-cell$/.test(name)) ?? 'hidden-with-no-breakpoint';
    };

    expect(headers.map(breakpointOf)).toEqual(cells.map(breakpointOf));
  });
});
