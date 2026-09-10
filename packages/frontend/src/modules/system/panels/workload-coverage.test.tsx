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

      expect(container.textContent).toContain('Not measured');
      expect(container.textContent).toContain('Not recorded');
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('[class*="border-dashed"]')).toBeNull();
    }
  });
});
