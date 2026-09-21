import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkloadCoverage } from './workload-coverage';

/*
 * The tile that says what is NOT measured, and the one live value it is allowed to read.
 *
 * Its statements about GPU-per-workload and tokens-per-workload are facts about what this product
 * instruments, not about what any query returned. Two live values pick which true sentence is
 * printed. The host GPU's name has three states rather than two — named, reported-as-absent, and
 * not read yet — because `/inference/hardware` in flight or failed is not the same fact as a host
 * with no GPU. The GPU sample source has four: measured by the host probe, measured by the tool,
 * absent on this node, and not known — and only `absent` may change the tag, because it is the one
 * that is a fact about this node's instrumentation rather than about a query.
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

  it('says VRAM is not read here, and how to fix that, when the snapshot reports no source on this node', () => {
    const { container } = render(<WorkloadCoverage hardware={undefined} gpuVramSource="absent" />);

    expect(container.textContent).toContain('Not read here');
    expect(container.textContent).toContain('NOT read on this node');
    expect(container.textContent).toContain('cihub fleet update --gpu-probe');
    expect(container.textContent).not.toContain('VRAM only');
    expect(container.textContent).not.toContain('is measured on this node');
    // Still says which HALF is a hardware ceiling everywhere, distinct from the half that is absent here.
    expect(container.textContent).toContain('UTILIZATION');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('names who measured VRAM when a source answered, and keeps the scoped tag', () => {
    const fromFile = render(<WorkloadCoverage hardware={undefined} gpuVramSource="host-file" />);
    expect(fromFile.container.textContent).toContain('host probe');
    expect(fromFile.container.textContent).toContain('VRAM only');
    expect(fromFile.container.textContent).not.toContain('Not read here');

    const fromTool = render(<WorkloadCoverage hardware={undefined} gpuVramSource="tool" />);
    expect(fromTool.container.textContent).toContain('run by the Hub itself');
    expect(fromTool.container.textContent).toContain('VRAM only');
  });

  it('does not claim VRAM is absent while the runtime monitor has not answered', () => {
    // Undefined (in flight or failed) and null (the backend's empty snapshot) are both "not known",
    // which is not the same fact as a node that answered and had no source.
    for (const source of [undefined, null]) {
      const { container } = render(<WorkloadCoverage hardware={undefined} gpuVramSource={source} />);
      expect(container.textContent).toContain('not known until the runtime monitor answers');
      expect(container.textContent).not.toContain('Not read here');
      expect(container.textContent).not.toContain('is measured on this node');
    }
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
