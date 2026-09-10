import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * EVERY BAND MUST FILL WHOLE ROWS OF THE 12-COLUMN BOARD.
 *
 * The page is one grid, and CSS auto-placement is silent about a band that does not divide 12: the
 * overflow simply wraps and sits alone against the empty remainder. That is how band D shipped as
 * `4 + 8` and then a stray `4`, leaving one panel beside eight dead columns — invisible in code
 * review, and exactly the wasted width this rebuild exists to remove.
 *
 * Parsed from the source rather than rendered, because the defect is arithmetic between sibling
 * JSX attributes: it has no distinguishing runtime signature, and every panel renders correctly on
 * its own.
 */

describe('resource monitor board', () => {
  const source = readFileSync(join(process.cwd(), 'src/modules/system/pages/resource-monitor-page.tsx'), 'utf8');

  it('gives every band a span total that fills whole 12-column rows', () => {
    // Bands are delimited by <BandHeader ...>; panels between them carry an xl span (or col-span-full).
    const bands = source.split(/<BandHeader\b/).slice(1);
    expect(bands.length).toBeGreaterThanOrEqual(3);

    const totals = bands.map((band) => {
      const spans = [...band.matchAll(/xl:col-span-(\d+)/g)].map((match) => Number(match[1]));
      return spans.reduce((sum, span) => sum + span, 0);
    });

    // A band with no explicit xl spans is full-width panels only, which is fine.
    for (const total of totals) {
      expect(total % 12).toBe(0);
    }
  });

  it('never spans a panel wider than the board', () => {
    const spans = [...source.matchAll(/xl:col-span-(\d+)/g)].map((match) => Number(match[1]));

    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span).toBeLessThanOrEqual(12);
  });
});
