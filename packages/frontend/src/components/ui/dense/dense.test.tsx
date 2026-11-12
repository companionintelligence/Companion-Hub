import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './dense';

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
