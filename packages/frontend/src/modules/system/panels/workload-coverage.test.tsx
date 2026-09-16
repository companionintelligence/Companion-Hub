import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkloadCoverage } from './workload-coverage';

/*
 * The tile that says what is NOT measured, and the one live value it is allowed to read.
 *
 * Its statements about GPU-per-workload and tokens-per-workload are constant by construction:
 * they are facts about what this product instruments, not about what any query returned, so no
 * data can change them. The only thing that varies is the host GPU's name, and that has three
 * states rather than two — named, reported-as-absent, and not read yet. The third exists because
 * `/inference/hardware` in flight or failed is not the same fact as a host with no GPU, and this
 * tile of all of them must not make that mistake.
 */

describe('WorkloadCoverage', () => {
  it('names the host GPU when the hardware query reported one', () => {
    const { container } = render(<WorkloadCoverage hardware={{ gpu: { vendor: 'amd', model: 'Radeon 8060S', vramMb: 128_085 } }} />);

    expect(container.textContent).toContain('amd Radeon 8060S');
    expect(container.textContent).toContain('125G');
  });

  it('says a host reported no GPU only when the host actually answered', () => {
    const { container } = render(<WorkloadCoverage hardware={{ cpu: { cores: 8 } }} />);

    expect(container.textContent).toContain('has not reported a GPU');
  });

  it('does not claim an absent GPU while the hardware query has not answered', () => {
    const { container } = render(<WorkloadCoverage hardware={undefined} />);

    expect(container.textContent).toContain('has not been read');
    expect(container.textContent).not.toContain('has not reported a GPU');
  });

  it('states what is not instrumented whatever the hardware query did, and draws nothing', () => {
    for (const hardware of [undefined, {}, { gpu: { vendor: 'amd', model: 'Radeon 8060S' } }]) {
      const { container } = render(<WorkloadCoverage hardware={hardware} />);

      // GPU VRAM is real now (see workload-trends.tsx) — this tile's GPU tag reflects that
      // precisely, "VRAM only", rather than the blanket "Not measured" it used to say.
      expect(container.textContent).toContain('VRAM only');
      expect(container.textContent).toContain('Not recorded');
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('[class*="border-dashed"]')).toBeNull();
    }
  });

  it('still says compute utilization per workload is not measured, distinct from the VRAM it now does measure', () => {
    const { container } = render(<WorkloadCoverage hardware={undefined} />);

    expect(container.textContent).toContain('UTILIZATION');
    expect(container.textContent).toContain('is NOT measured');
    // The GPU tag itself must read as the narrower, true claim, never regress to the old blanket one.
    expect(container.textContent).toContain('VRAM only');
  });

  it('points at the real per-model token counts now in Pool activity, not a fake per-workload figure', () => {
    const { container } = render(<WorkloadCoverage hardware={undefined} />);

    expect(container.textContent).toContain('Pool activity');
    expect(container.textContent).toContain('per MODEL');
    // The exact numbers this tile is forbidden from ever showing, so a later edit reintroducing
    // one of them fails loudly here rather than silently passing review.
    expect(container.textContent).not.toMatch(/\b0\s*(tokens|%|MB|GB)\b/i);
  });
});
