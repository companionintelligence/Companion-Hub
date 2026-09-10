import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DASH, KpiRail, RailStat, Sparkline, StepAreaChart } from './dense';

/*
 * The two hand-drawn charts, tested for the one thing that is not visible in a screenshot: what
 * they do with a `null`.
 *
 * A gap in a series means the sample landed and this row was not in it. Closing that gap draws a
 * line between two values with nothing measured between them, and — worse — a series that had a
 * zero substituted for the gap is indistinguishable from a genuinely idle machine. Both charts
 * must break instead, and `Sparkline` in particular used to filter the nulls out and join what
 * was left, which is the same lie at 64px.
 */

describe('Sparkline', () => {
  it('breaks the line at a gap instead of joining across it', () => {
    const { container } = render(<Sparkline points={[1, null, 3]} />);
    const polylines = container.querySelectorAll('polyline');

    expect(polylines).toHaveLength(2);
  });

  it('draws one unbroken run when nothing is missing', () => {
    const { container } = render(<Sparkline points={[1, 2, 3]} />);

    expect(container.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('keeps a gap at its real width rather than sliding the runs together', () => {
    // Width 64 over four slots is a step of 64/3. The run after a two-sample gap must start at
    // the third step, not at the second — which is where filtering the nulls out would put it.
    const { container } = render(<Sparkline points={[1, null, null, 4]} width={64} />);
    const [first, second] = [...container.querySelectorAll('polyline')];

    expect(first?.getAttribute('points')?.startsWith('0,')).toBe(true);
    expect(second?.getAttribute('points')?.startsWith('64,')).toBe(true);
  });

  it('renders a dash rather than a flat line when there is not enough to be a trend', () => {
    const { container } = render(<Sparkline points={[null, 5, null]} />);

    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('—');
  });
});

describe('StepAreaChart', () => {
  it('drops the gridlines and the frame at row scale but keeps the baseline', () => {
    const { container } = render(<StepAreaChart variant="row" height={38} points={[1, 2]} max={10} label="row" />);
    const svg = container.querySelector('svg');

    // Three gridlines plus a baseline in the panel variant; the baseline alone here.
    expect(svg?.querySelectorAll('line')).toHaveLength(1);
    expect(svg?.getAttribute('class')).not.toContain('border-border/60');
  });

  it('keeps the panel variant exactly as it was, so the node detail card is untouched', () => {
    const { container } = render(<StepAreaChart points={[1, 2]} max={10} label="panel" />);
    const svg = container.querySelector('svg');

    expect(svg?.querySelectorAll('line')).toHaveLength(4);
    expect(svg?.getAttribute('class')).toContain('border-border/60');
  });

  it('reserves dashed borders for the panel variant, where they mean "waiting for samples"', () => {
    const panel = render(<StepAreaChart points={[null, null]} max={10} label="panel" />);
    expect(panel.container.querySelector('div')?.getAttribute('class')).toContain('border-dashed');

    const row = render(<StepAreaChart variant="row" points={[null, null]} max={10} label="row" />);
    expect(row.container.querySelector('div')?.getAttribute('class')).not.toContain('border-dashed');
  });
});

/*
 * THE RAIL'S THREE STATES, which are three and not two.
 *
 * `value` arrives already {@link DASH} when a figure was never measured — a peer that cannot read
 * its own counter, a field an older build does not send. So a FAILED query must render something
 * else entirely: a dash in both cases says "we asked and it broke" and "nothing reports this" in
 * the same glyph, at the most-read spot on the page, which is the collision the whole dashboard is
 * built to avoid. It regressed once by putting the word in a `title` and in the optional `sub`,
 * where touch cannot reach it and stats without a `sub` lost it completely.
 */

const READY_STATE = { pending: false, failed: false };

describe('RailStat', () => {
  /* The real copy, not the key — these assert what an operator actually reads. */
  const FAILED_COPY = 'Not checked — this request failed';

  it('explains a failed query in the value slot instead of drawing a glyph', () => {
    const { container } = render(<RailStat stat={{ id: 'a', value: 7, label: 'Peers', state: { pending: false, failed: true } }} />);

    expect(container.textContent).toContain(FAILED_COPY);
    // In the value slot itself, not tucked into a `title` a touch device can never reach.
    const slot = container.querySelector('span');
    expect(slot?.textContent).toBe(FAILED_COPY);
  });

  it('never reuses the bare dash of a never-measured value for a failed query', () => {
    const failed = render(<RailStat stat={{ id: 'a', value: 7, label: 'Peers', state: { pending: false, failed: true } }} />);
    const unmeasured = render(<RailStat stat={{ id: 'b', value: DASH, label: 'Peers', state: READY_STATE }} />);

    // The unmeasured value IS a lone dash; the failed one must never be, or the two states
    // become one glyph. (`toBe`, not `toContain`: the failure copy contains an em dash of its own.)
    expect(unmeasured.container.querySelector('span')?.textContent).toBe(DASH);
    expect(failed.container.querySelector('span')?.textContent).not.toBe(DASH);
  });

  it('shows a skeleton rather than any glyph while the query is still in flight', () => {
    const { container } = render(<RailStat stat={{ id: 'a', value: 7, label: 'Peers', state: { pending: true, failed: false } }} />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain(FAILED_COPY);
    expect(container.textContent).not.toContain('7');
  });

  it('renders the real figure when the query succeeded', () => {
    const { container } = render(<RailStat stat={{ id: 'a', value: 7, label: 'Peers', state: READY_STATE }} />);

    expect(container.textContent).toContain('7');
    expect(container.textContent).not.toContain(FAILED_COPY);
  });
});

describe('KpiRail', () => {
  /*
   * A grid, never a flex-wrap. Wrapping laid the stats out by their own content widths, so the
   * twelfth landed alone on a second row beside a full row of empty card — dead space in the band
   * this rebuild exists to make dense.
   */
  it('lays the stats out on a fixed column count so a row is never left ragged', () => {
    const stats = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      value: index,
      label: `L${index}`,
      state: READY_STATE,
      mobile: true,
    }));
    const { container } = render(<KpiRail stats={stats} />);
    const cls = container.firstElementChild?.getAttribute('class') ?? '';

    expect(cls).toContain('grid');
    expect(cls).not.toContain('flex-wrap');
    // Every count divides twelve, so no breakpoint can strand a partial row.
    for (const cols of ['grid-cols-3', 'sm:grid-cols-6', 'xl:grid-cols-12']) {
      expect(cls).toContain(cols);
    }
  });
});
