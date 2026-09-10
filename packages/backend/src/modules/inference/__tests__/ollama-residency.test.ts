import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OllamaBackend } from '../backends/ollama.backend';

vi.mock('axios');

/**
 * Maps Ollama's `/api/ps` onto {@link BackendResidency}. The payloads below are the real
 * shape returned by ollama 0.33.3 on the test fleet, including the zero-value `expires_at`
 * a pinned model carries.
 */
function makeBackend(): OllamaBackend {
  const backend = Object.create(OllamaBackend.prototype) as OllamaBackend & {
    resolveUrl: () => Promise<string>;
    invalidateResolvedUrl: () => void;
    logger: { debug: () => void; error: () => void };
    type: string;
  };

  backend.resolveUrl = async () => 'http://ollama:11434';
  backend.invalidateResolvedUrl = () => {};
  backend.logger = { debug: () => {}, error: () => {} };
  Object.defineProperty(backend, 'type', { value: 'ollama', writable: false });

  return backend;
}

describe('OllamaBackend.listResident', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
  });

  it('reports an empty /api/ps as measured-and-empty, not as unknown', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { models: [] } });

    const result = await makeBackend().listResident();

    // The live fleet's actual state: 11 models on disk, none resident. That has to be
    // expressible as a measured fact, or the whole route is pointless.
    expect(result.source).toBe('measured');
    expect(result.models).toEqual([]);
  });

  it('carries the engine-attributed GPU bytes and the total separately', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        models: [
          {
            name: 'gemma3:1b',
            size: 2_000_000_000,
            size_vram: 2_000_000_000,
            expires_at: '2026-09-10T03:05:00Z',
            context_length: 32_768,
            details: { quantization_level: 'Q4_K_M' },
          },
          // size > size_vram in the engine's own bookkeeping. Both are carried; neither is
          // a placement measurement — see the field doc for why the difference must not be
          // read as CPU offload.
          { name: 'qwen3-coder:30b', size: 20_000_000_000, size_vram: 12_000_000_000, expires_at: '2026-09-10T03:05:00Z' },
        ],
      },
    });

    const result = await makeBackend().listResident();

    expect(result.models).toEqual([
      {
        id: 'gemma3:1b',
        engineGpuBytes: 2_000_000_000,
        totalBytes: 2_000_000_000,
        expiresAt: '2026-09-10T03:05:00Z',
        contextLength: 32_768,
        quantization: 'Q4_K_M',
      },
      {
        id: 'qwen3-coder:30b',
        engineGpuBytes: 12_000_000_000,
        totalBytes: 20_000_000_000,
        expiresAt: '2026-09-10T03:05:00Z',
        contextLength: null,
        quantization: null,
      },
    ]);
  });

  it('treats a zero-value expires_at as no expiry', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { models: [{ name: 'pinned:1b', size: 1, size_vram: 1, expires_at: '0001-01-01T00:00:00Z' }] },
    });

    const result = await makeBackend().listResident();

    // `keep_alive: -1` pins a model forever and ollama sends the zero time. Rendering that
    // as a date would put "expires in the year 1" in front of an operator.
    expect(result.models?.[0]?.expiresAt).toBeNull();
  });

  it('reports missing sizes as null rather than zero', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { models: [{ name: 'odd:1b' }] } });

    const result = await makeBackend().listResident();

    expect(result.models?.[0]).toEqual({
      id: 'odd:1b',
      engineGpuBytes: null,
      totalBytes: null,
      expiresAt: null,
      contextLength: null,
      quantization: null,
    });
  });

  it('reports an unreachable engine as unreachable with null models', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await makeBackend().listResident();

    expect(result.source).toBe('unreachable');
    expect(result.models).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });
});
