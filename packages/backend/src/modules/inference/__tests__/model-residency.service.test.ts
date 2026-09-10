import type { BackendResidency, InferenceBackendType } from '@ci-hub/common/types';
import { describe, expect, it, vi } from 'vitest';

import type { InferenceBackend } from '../backends/backend.interface';
import { ModelResidencyService } from '../model-residency.service';

/**
 * The property under test throughout: an unmeasured value is never rendered as a measured
 * one. `models: null` (could not ask) and `models: []` (asked, nothing loaded) are different
 * facts, and a total of `null` (nobody reported VRAM) is not `0` (the GPUs are empty).
 */

function backend(type: string, listResident?: () => Promise<BackendResidency>): InferenceBackend {
  return { type: type as InferenceBackendType, ...(listResident ? { listResident } : {}) } as InferenceBackend;
}

function serviceWith(backends: InferenceBackend[]) {
  const registry = { entries: () => backends.map((b) => [b.type, b] as const) };
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  return new ModelResidencyService(registry as never, logger as never);
}

const AT = '2026-09-10T03:00:00.000Z';

describe('ModelResidencyService', () => {
  it('reports a backend with no listResident as unsupported, with null models', async () => {
    const report = await serviceWith([backend('vllm')]).getReport(AT);

    expect(report.backends).toEqual([{ backend: 'vllm', source: 'unsupported', models: null }]);
    // Not an empty array: this engine was never asked, so it cannot be said to hold nothing.
    expect(report.backends[0]?.models).toBeNull();
    expect(report.residentCount).toBe(0);
  });

  it('distinguishes "asked, nothing loaded" from "could not ask"', async () => {
    const report = await serviceWith([
      backend('ollama', async () => ({ backend: 'ollama', source: 'measured', models: [] })),
      backend('lemonade', async () => ({ backend: 'lemonade', source: 'unreachable', models: null, error: 'ECONNREFUSED' })),
    ]).getReport(AT);

    const measured = report.backends.find((entry) => entry.backend === 'ollama');
    const unreachable = report.backends.find((entry) => entry.backend === 'lemonade');

    expect(measured?.source).toBe('measured');
    expect(measured?.models).toEqual([]);
    expect(unreachable?.source).toBe('unreachable');
    expect(unreachable?.models).toBeNull();
  });

  it('totals VRAM only across backends that reported it', async () => {
    const report = await serviceWith([
      backend('ollama', async () => ({
        backend: 'ollama',
        source: 'measured',
        models: [
          { id: 'a', vramBytes: 1_000, totalBytes: 1_200, expiresAt: null, contextLength: null, quantization: null },
          { id: 'b', vramBytes: 2_000, totalBytes: 2_000, expiresAt: null, contextLength: null, quantization: null },
        ],
      })),
      // Reports residency but not size — must contribute a model, and nothing to the total.
      backend('mtplx', async () => ({
        backend: 'mtplx',
        source: 'implicit',
        models: [{ id: 'c', vramBytes: null, totalBytes: null, expiresAt: null, contextLength: null, quantization: null }],
      })),
    ]).getReport(AT);

    expect(report.totalVramBytes).toBe(3_000);
    expect(report.residentCount).toBe(3);
  });

  it('reports a null VRAM total when no backend measured any, rather than zero', async () => {
    const report = await serviceWith([
      backend('mtplx', async () => ({
        backend: 'mtplx',
        source: 'implicit',
        models: [{ id: 'c', vramBytes: null, totalBytes: null, expiresAt: null, contextLength: null, quantization: null }],
      })),
      backend('vllm'),
    ]).getReport(AT);

    // A zero here would claim the GPUs are empty. One model IS resident; its size is unknown.
    expect(report.totalVramBytes).toBeNull();
    expect(report.residentCount).toBe(1);
  });

  it('keeps the report alive when one backend throws', async () => {
    const report = await serviceWith([
      backend('ollama', async () => ({
        backend: 'ollama',
        source: 'measured',
        models: [{ id: 'a', vramBytes: 500, totalBytes: 500, expiresAt: null, contextLength: null, quantization: null }],
      })),
      backend('dspark', async () => {
        throw new Error('boom');
      }),
    ]).getReport(AT);

    expect(report.backends).toHaveLength(2);
    expect(report.backends.find((entry) => entry.backend === 'ollama')?.models).toHaveLength(1);

    const thrown = report.backends.find((entry) => entry.backend === 'dspark');

    expect(thrown?.source).toBe('unreachable');
    expect(thrown?.models).toBeNull();
    expect(thrown?.error).toContain('boom');
  });

  it('names only the backends that can actually answer', async () => {
    const service = serviceWith([backend('ollama', async () => ({ backend: 'ollama', source: 'measured', models: [] })), backend('vllm')]);

    expect(service.supportedBackends()).toEqual(['ollama']);
  });
});
