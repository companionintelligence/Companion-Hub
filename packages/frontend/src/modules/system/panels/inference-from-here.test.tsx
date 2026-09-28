import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { inferenceFromHere, type OwnInference } from '../pool-node-series';
import type { RoutingLogEntry } from '../use-dashboard-data';
import { InferenceFromHere } from './inference-from-here';

/*
 * The tile's three honesty rules: a log that failed or has not answered is never a row of zeros,
 * tokens nobody reported are never "0", and a count that may be missing rows says so.
 */

const READY = { pending: false, failed: false };
const WINDOW = { from: Date.parse('2026-09-28T14:42:00Z'), to: Date.parse('2026-09-28T15:12:00Z') };
const NOW = Date.parse('2026-09-28T15:11:30Z');

const row = (at: string, extras: Partial<RoutingLogEntry> = {}): RoutingLogEntry => ({
  at,
  direction: 'outbound',
  model: 'gemma3:1b',
  node: 'local',
  outcome: 'served',
  status: 200,
  durationMs: 1_507,
  stream: false,
  ...extras,
});

function renderTile(own: OwnInference, overrides: Partial<Parameters<typeof InferenceFromHere>[0]> = {}) {
  return render(
    <InferenceFromHere
      own={own}
      minutes={30}
      partial={false}
      windowFrom={WINDOW.from}
      startedAt="2026-09-26T23:47:49.027Z"
      unlogged="none"
      now={NOW}
      state={READY}
      {...overrides}
    />,
  ).container;
}

const chip = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('span')].find((span) => span.textContent === label && span.className.includes('uppercase'))?.parentElement
    ?.textContent;

describe('InferenceFromHere', () => {
  const EMPTY = inferenceFromHere([], WINDOW);

  it('renders a failed routing log as a failure, never as zero requests', () => {
    const container = renderTile(EMPTY, { state: { pending: false, failed: true } });

    expect(container.textContent).toContain('Could not read the routing log.');
    expect(container.textContent).not.toContain('Nothing sent');
    expect(container.querySelector('[data-testid="inference-from-here"]')).toBeNull();
  });

  it('shows a skeleton, not figures, while the log has not answered', () => {
    const container = renderTile(EMPTY, { state: { pending: true, failed: false } });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inference-from-here"]')).toBeNull();
  });

  it('says a quiet half hour in words rather than as six zeros', () => {
    const container = renderTile(EMPTY);

    expect(container.textContent).toContain('Nothing sent from this Hub in the last 30 minutes.');
    expect(chip(container, 'Requests')).toBeUndefined();
  });

  it("counts this Hub's own requests and leaves out what peers sent in", () => {
    const own = inferenceFromHere(
      [
        row('2026-09-28T15:04:27.504Z', { usage: { promptTokens: 17, completionTokens: 3, totalTokens: 20 } }),
        row('2026-09-28T15:04:29.124Z', {
          model: 'qwen3.5:4b',
          node: 'core-17.tailnet-example.ts.net',
          usage: { promptTokens: 17, completionTokens: 8, totalTokens: 25 },
        }),
        row('2026-09-28T15:11:00.658Z', { direction: 'inbound', model: null, node: 'beta-max.tailnet-example.ts.net', path: '/api/show' }),
      ],
      WINDOW,
    );
    const container = renderTile(own);

    expect(chip(container, 'Requests')).toBe('2Requests');
    expect(chip(container, 'Prompt tok')).toBe('34Prompt tok');
    expect(chip(container, 'Output tok')).toBe('11Output tok');
    const models = [...container.querySelectorAll('[data-testid="inference-from-here-models"] li')].map((item) => item.textContent);
    expect(models).toEqual(['qwen3.5:4b1 req25 tok', 'gemma3:1b1 req20 tok']);
  });

  it('says how many served requests reported usage when not all of them did', () => {
    const own = inferenceFromHere(
      [
        row('2026-09-28T15:00:00Z', { usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }),
        row('2026-09-28T15:01:00Z'),
        row('2026-09-28T15:02:00Z'),
      ],
      WINDOW,
    );
    const container = renderTile(own);

    expect(chip(container, 'Prompt tok')).toBe('100Prompt tok1 of 3 reported usage');
  });

  it('prints unreported tokens as a dash, never as 0', () => {
    const own = inferenceFromHere([row('2026-09-28T15:00:00Z'), row('2026-09-28T15:01:00Z')], WINDOW);
    const container = renderTile(own);

    expect(chip(container, 'Prompt tok')).toBe('—Prompt tok0 of 2 reported usage');
    expect(chip(container, 'Output tok')).toBe('—Output tok0 of 2 reported usage');
    const models = [...container.querySelectorAll('[data-testid="inference-from-here-models"] li')].map((item) => item.textContent);
    expect(models).toEqual(['gemma3:1b2 req—']);
  });

  it('gives a median first byte, and a p90 only once there are ten to take it from', () => {
    const streamed = (ms: number, minute: number) => row(`2026-09-28T15:0${minute}:00Z`, { stream: true, durationMs: ms });
    const few = renderTile(inferenceFromHere([streamed(400, 1), streamed(800, 2)], WINDOW));
    expect(chip(few, '1st byte p50')).toBe('400 ms1st byte p502 streamed');

    // Nine: nearest rank would name the slowest request its p90, so there is none.
    const nine = renderTile(
      inferenceFromHere(
        [400, 500, 600, 700, 800, 900, 1_000, 1_100, 32_227].map((ms, index) => streamed(ms, index)),
        WINDOW,
      ),
    );
    expect(chip(nine, '1st byte p50')).toBe('800 ms1st byte p509 streamed');

    const ten = renderTile(
      inferenceFromHere(
        [400, 500, 600, 700, 800, 900, 1_000, 1_100, 1_200, 32_227].map((ms, index) => streamed(ms, index)),
        WINDOW,
      ),
    );
    expect(chip(ten, '1st byte p50')).toBe('800 ms1st byte p50p90 1.2 s');

    const none = renderTile(inferenceFromHere([row('2026-09-28T15:00:00Z')], WINDOW));
    expect(chip(none, '1st byte p50')).toBe('—1st byte p50none streamed');
  });

  it('marks every count as a floor when the ring may have dropped rows from the window', () => {
    const container = renderTile(
      inferenceFromHere([row('2026-09-28T15:00:00Z', { usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })], WINDOW),
      { partial: true },
    );

    // One note for the whole tile: Requests, Failed, Failovers and both token totals come from the same rows.
    expect(container.querySelector('[data-testid="inference-from-here-partial"]')?.textContent).toBe(
      'At least: the log dropped older rows from this window, so every count here is a floor.',
    );
    expect(chip(container, 'Requests')).toBe('1Requests');
  });

  it('never says "nothing sent" over a window the log may not fully cover', () => {
    const container = renderTile(EMPTY, { partial: true });

    expect(container.textContent).not.toContain('Nothing sent');
    expect(container.querySelector('[data-testid="inference-from-here"]')?.textContent).toContain(
      'None among the rows still held. The log dropped older rows from this window.',
    );
  });

  it("qualifies Failed the way the rail does: callers who hung up aren't a pool that failed them", () => {
    const own = inferenceFromHere(
      [
        row('2026-09-28T15:00:00Z', { outcome: 'failed', status: null, clientClosed: true, durationMs: 40_000 }),
        row('2026-09-28T15:01:00Z', { outcome: 'failed', status: null, budgetMs: 300_000, durationMs: 300_100 }),
        row('2026-09-28T15:02:00Z'),
      ],
      WINDOW,
    );
    const container = renderTile(own);

    expect(chip(container, 'Failed')).toBe('2Failed1 past budget · 1 caller left');
  });

  it('says when the log itself starts inside the window', () => {
    const container = renderTile(inferenceFromHere([row('2026-09-28T15:00:00Z')], WINDOW), { startedAt: '2026-09-28T15:01:30Z' });

    expect(container.textContent).toContain('Log starts at the Hub restart, 10m 0s ago.');
  });

  it('never says "nothing sent" when some calls bypass the log: it says what was logged and which calls were not', () => {
    const container = renderTile(EMPTY, { unlogged: 'v1' });
    const tile = container.querySelector('[data-testid="inference-from-here"]')?.textContent ?? '';

    expect(tile).not.toContain('Nothing sent');
    expect(tile).toContain('Nothing logged from this Hub in the last 30 minutes.');
    expect(container.querySelector('[data-testid="inference-from-here-unlogged"]')?.textContent).toBe(
      'No peer is connected, so calls to /api/inference/v1 are served here without being logged. Calls through the pool proxy are logged.',
    );
  });

  it('shows only the gap, and no count at all, when apps call their engines directly', () => {
    const container = renderTile(EMPTY, { unlogged: 'apps' });
    const tile = container.querySelector('[data-testid="inference-from-here"]')?.textContent ?? '';

    expect(tile).not.toContain('Nothing');
    expect(container.querySelector('[data-testid="inference-from-here-unlogged"]')?.textContent).toBe(
      "No peer is connected and apps aren't routed through the pool, so they call their engines directly and nothing they send is logged here.",
    );
  });

  it('says it cannot tell, rather than "nothing sent", while pool status is unknown', () => {
    const container = renderTile(EMPTY, { unlogged: 'unknown' });
    const tile = container.querySelector('[data-testid="inference-from-here"]')?.textContent ?? '';

    expect(tile).not.toContain('Nothing sent');
    expect(tile).toContain('Nothing logged from this Hub in the last 30 minutes.');
    expect(container.querySelector('[data-testid="inference-from-here-unlogged"]')?.textContent).toBe(
      "Pool status didn't load, so whether some calls bypassed the log is unknown.",
    );
  });

  it('keeps the logged counts and names the gap beside them when some calls bypass the log', () => {
    const container = renderTile(inferenceFromHere([row('2026-09-28T15:00:00Z')], WINDOW), { unlogged: 'v1' });

    expect(chip(container, 'Requests')).toBe('1Requestslogged calls only');
    expect(container.querySelector('[data-testid="inference-from-here-unlogged"]')).not.toBeNull();
  });

  it('says who the callers are as the log knows them: anything that entered the pool here', () => {
    const container = renderTile(EMPTY);

    expect(container.textContent).toContain(
      "Requests that entered the pool at this Hub, from its apps, anything on its LAN or tailnet, and API-key clients, wherever they ran. Work peers forward here isn't counted.",
    );
  });
});
