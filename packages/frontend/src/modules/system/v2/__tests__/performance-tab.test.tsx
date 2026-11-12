import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PerformanceTab, type PerformanceTabProps, smoothCpu } from '../performance-tab';

const ready = { pending: false, failed: false };
const GB = 1024;

function props(overrides: Partial<PerformanceTabProps> = {}): PerformanceTabProps {
  return {
    load: { diskUsed: 1769, diskSize: 1832, percentUsed: 97, cpuLoad: 1.1, cpuCores: 32, memoryTotal: 123, memoryUsed: 111 },
    loadState: ready,
    telemetry: [],
    telemetryState: ready,
    bucketSeconds: 5,
    span: 30,
    onSpanChange: vi.fn(),
    hardware: {
      cpu: { cores: 32, arch: 'x86_64', model: 'AMD RYZEN AI MAX+ 395' },
      ram: { totalMb: 123 * GB, availableMb: 12 * GB, usedMb: 111 * GB },
      gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', unifiedMemory: true, hostRocmAvailable: true, runtimeAvailable: false },
      os: { name: 'Ubuntu', version: '26.04.1 LTS' },
    },
    hardwareState: ready,
    memory: { modelUsedRamMb: 5.7 * GB, modelBudgetRamMb: 101 * GB },
    residency: {
      backends: [
        {
          backend: 'ollama',
          source: 'measured',
          models: [{ id: 'qwen3.5:9b', engineGpuBytes: null, totalBytes: 6_130_740_755, expiresAt: null, contextLength: null, quantization: null }],
        },
      ],
      residentCount: 1,
      sampledAt: '2026-11-12T05:00:00Z',
    },
    modelsState: ready,
    engines: [
      { type: 'ollama', running: true, healthy: true },
      { type: 'vllm', running: false, healthy: false },
    ],
    diskModels: [
      { id: 'qwen3.5:9b', backend: 'ollama', sizeBytes: 6_600_000_000, resident: true },
      { id: 'gemma3:1b', backend: 'ollama', sizeBytes: 815_000_000, resident: false },
    ],
    monitor: undefined,
    monitorState: ready,
    appName: (_urn, fallback) => fallback,
    now: Date.parse('2026-11-12T05:00:00Z'),
    onShowApps: vi.fn(),
    ...overrides,
  };
}

describe('Performance tab', () => {
  it('opens on CPU and says what each resource holds', () => {
    render(<PerformanceTab {...props()} />);

    expect(screen.getByTestId('resource-tile-cpu').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('resource-tile-memory').textContent).toContain('90%');
    expect(screen.getByTestId('resource-tile-disk').textContent).toContain('97%');
    expect(screen.getByTestId('resource-tile-models').textContent).toContain('1 of 2');
    expect(screen.getByText('Ubuntu 26.04.1 LTS')).toBeTruthy();
  });

  it('splits memory into apps, models, the system and what is free', () => {
    render(<PerformanceTab {...props()} />);
    fireEvent.click(screen.getByTestId('resource-tile-memory'));

    const detail = screen.getByTestId('resource-detail');
    expect(detail.textContent).toContain('System and GPU');
    expect(detail.textContent).toContain('AI models5.7 GB');
    expect(detail.textContent).toContain('Available12 GB');
  });

  it('gives each model its size on disk and in memory', () => {
    render(<PerformanceTab {...props()} />);
    fireEvent.click(screen.getByTestId('resource-tile-models'));

    const rows = screen.getAllByTestId('resources-model-row');
    expect(rows[0]?.textContent).toContain('6.1 GB');
    expect(rows[0]?.textContent).toContain('5.7 GB');
    expect(rows[1]?.textContent).toContain('777 MB');
    expect(rows[1]?.textContent).toContain('—');
    expect(screen.getByText('Not running: vLLM.')).toBeTruthy();
  });

  it('says the CPU reading failed instead of showing a zero', () => {
    render(<PerformanceTab {...props({ load: undefined, loadState: { pending: false, failed: true } })} />);

    expect(screen.getByText(/Couldn't read this machine's load/)).toBeTruthy();
  });

  it('averages raw 5-second CPU readings into 30-second points and leaves averaged ones alone', () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({ sampledAt: `t${i}`, cpuLoad: i < 6 ? 0 : 6, memoryUsed: null, memoryTotal: null }));

    expect(smoothCpu(raw, 5)).toEqual([0, 6]);
    expect(smoothCpu(raw.slice(0, 3), 240)).toEqual([0, 0, 0]);
  });
});
