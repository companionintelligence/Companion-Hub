import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MemoryBudgetSummary } from '@/modules/system/use-dashboard-data';
import { ModelMemory } from './local-resources';

/*
 * The model-memory budget, as beta-red produced it on 2026-09-20: the Hub's router had loaded
 * nothing, so the old panel read "0G of 10G" while nvidia-smi held 9 of 10 GiB for an Ollama
 * runner and an out-of-band vLLM. The rows below are what the same node reports now, and the
 * assertions are about the WORDS beside each figure — a number an engine planned and a number
 * nvidia-smi measured are different kinds of number (Ollama's /api/ps said 1.5G for a runner
 * nvidia-smi held at 2.9G), and a reader chasing that gap must be able to see which is which.
 */

const ready = { pending: false, failed: false };
const discrete = { gpu: { available: true, vendor: 'nvidia', model: 'RTX 3080', vramMb: 10_240, unifiedMemory: false } };

const betaRed: MemoryBudgetSummary = {
  totalVramMb: 10_240,
  totalRamMb: 32_000,
  systemReservedRamMb: 2048,
  dockerOverheadMb: 1500,
  appContainerBudgetMb: 1500,
  modelBudgetVramMb: 9728,
  modelBudgetRamMb: 28_452,
  modelUsedVramMb: 2926 + 6104,
  modelUsedRamMb: 0,
  pinnedVramMb: 0,
  pinnedRamMb: 0,
  usage: {
    sampledAt: '2026-09-20T00:00:00Z',
    backends: [
      { backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 2926, source: 'process' },
      { backend: 'vllm', models: ['Qwen/Qwen2.5-3B-Instruct-AWQ'], pool: 'vram', usedMb: 6104, source: 'process' },
    ],
  },
};

describe('ModelMemory', () => {
  it('counts what the engines hold, measured per process, and names the tool that measured it', () => {
    const { container } = render(<ModelMemory memory={betaRed} hardware={discrete} state={ready} />);
    const vram = container.querySelector('[data-testid="model-memory-vram"]') as HTMLElement;

    expect(vram.textContent).toContain('8.8G of 9.5G');
    expect(vram.textContent).toContain('gemma4:e4b');
    // The vendor tool by name: it is what an operator runs to check the number.
    expect(vram.textContent).toContain('2.9G · nvidia-smi');
    expect(vram.textContent).toContain('Qwen/Qwen2.5-3B-Instruct-AWQ');
    expect(vram.textContent).toContain('6G · nvidia-smi');
    expect(container.textContent).not.toContain('floor');
  });

  it("says when a figure is the engine's own plan rather than a reading", () => {
    // No vendor tool reached the runner (a CPU-only node, or nvidia-smi absent from the image):
    // Ollama's /api/ps figure stands in, and the row must not pass it off as measured.
    const budget: MemoryBudgetSummary = {
      ...betaRed,
      modelUsedVramMb: 1533,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [{ backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 1533, source: 'engine' }],
      },
    };
    const { container } = render(<ModelMemory memory={budget} hardware={discrete} state={ready} />);

    expect(container.textContent).toContain("1.5G · the engine's own figure");
    expect(container.textContent).not.toContain('nvidia-smi');
  });

  it('writes a floor when an engine holds a model nothing could size, and never renders that engine as 0', () => {
    const budget: MemoryBudgetSummary = {
      ...betaRed,
      modelUsedVramMb: 2926,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [
          { backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 2926, source: 'process' },
          { backend: 'vllm', models: ['Qwen/Qwen2.5-3B-Instruct-AWQ'], pool: 'vram', usedMb: null, source: 'unmeasured' },
        ],
      },
    };
    const { container } = render(<ModelMemory memory={budget} hardware={discrete} state={ready} />);
    const vram = container.querySelector('[data-testid="model-memory-vram"]') as HTMLElement;

    expect(vram.textContent).toContain('≥2.9G of 9.5G');
    expect(vram.textContent).toContain('— · holds a model, not measured');
    expect(vram.textContent).not.toContain('0G · holds');
    expect(container.textContent).toContain('vllm holds a model this node cannot size, so Used is a floor');
  });

  it('names the AMD tool on an AMD node, and files unified-memory engines under RAM', () => {
    const budget: MemoryBudgetSummary = {
      totalVramMb: 0,
      totalRamMb: 131_072,
      modelBudgetVramMb: 0,
      modelBudgetRamMb: 120_000,
      modelUsedVramMb: 0,
      modelUsedRamMb: 7319 + 17_788,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [
          { backend: 'ollama', models: ['qwen3:9b'], pool: 'ram', usedMb: 7319, source: 'engine' },
          { backend: 'lucebox', models: ['qwen3.6-27b'], pool: 'ram', usedMb: 17_788, source: 'process' },
        ],
      },
    };
    const unified = { gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 2048, unifiedMemory: true } };
    const { container } = render(<ModelMemory memory={budget} hardware={unified} state={ready} />);

    expect(container.querySelector('[data-testid="model-memory-vram"]')).toBeNull();
    const ram = container.querySelector('[data-testid="model-memory-ram"]') as HTMLElement;
    expect(ram.textContent).toContain('lucebox');
    expect(ram.textContent).toContain('17G · rocm-smi');
  });

  it('says the engines hold nothing, and where Used comes from, when no engine has a model', () => {
    const budget: MemoryBudgetSummary = { ...betaRed, modelUsedVramMb: 0, usage: { sampledAt: '2026-09-20T00:00:00Z', backends: [] } };
    const { container } = render(<ModelMemory memory={budget} hardware={discrete} state={ready} />);

    expect(container.textContent).toContain('No engine holds a model right now');
  });

  it('labels Hub bookkeeping as such, because it is not a measurement', () => {
    const budget: MemoryBudgetSummary = {
      ...betaRed,
      modelUsedVramMb: 5000,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [{ backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 5000, source: 'registry' }],
      },
    };
    const { container } = render(<ModelMemory memory={budget} hardware={discrete} state={ready} />);

    expect(container.textContent).toContain('4.9G · Hub bookkeeping, engine not reachable');
  });
});
