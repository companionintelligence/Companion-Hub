import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import type { LoggerService } from '@/core/logger/logger.service';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { CURATED_MODELS } from '../catalog/curated-models';
import { ModelRegistryService } from '../model-registry.service';
import { LEMONADE_10_2_0_SHOW_ALL_IDS, lemonadeShowAllBody } from './lemonade-10.2.0-registry.fixture';

vi.mock('axios');

const GB = 1024;
const profile = (o: { vendor?: HardwareProfile['gpu']['vendor']; vramMb?: number; unifiedMemory?: boolean; ramMb: number; tier: HardwareTier }) =>
  ({
    gpu: {
      available: true,
      vendor: o.vendor ?? 'nvidia',
      model: 'x',
      vramMb: o.vramMb ?? 0,
      unifiedMemory: o.unifiedMemory ?? false,
      driverVersion: '1',
      runtimeAvailable: true,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: o.ramMb, availableMb: o.ramMb },
    cpu: { arch: 'x86_64', cores: 16, model: 'x' },
    effectiveInferenceMemoryMb: o.unifiedMemory ? o.ramMb : (o.vramMb ?? 0),
    tier: o.tier,
    os: { platform: 'linux', name: 'linux', version: '' },
  }) as HardwareProfile;

/** The hardware the audit found the Hub picking unservable Lemonade defaults for. */
const FLEET_PROFILES: Record<string, HardwareProfile> = {
  'beta-red, RTX 3080 10 GB': profile({ vramMb: 10 * GB, ramMb: 32 * GB, tier: 'medium' }),
  'beta-1, RX 7900 XTX 24 GB': profile({ vendor: 'amd', vramMb: 24 * GB, ramMb: 64 * GB, tier: 'medium' }),
  'Strix Halo, 128 GB unified': profile({ vendor: 'amd', unifiedMemory: true, ramMb: 128 * GB, tier: 'high' }),
};

/** A registry wired to a real Lemonade backend that has probed a 10.2.0 server. */
async function registryAgainst10_2_0(downloaded: string[] = []) {
  (axios.get as any) = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/v1/health')) return Promise.resolve({ status: 200, data: { status: 'ok', version: '10.2.0' } });
    if (url.endsWith('/v1/models?show_all=true')) return Promise.resolve({ data: lemonadeShowAllBody(downloaded) });
    if (url.endsWith('/v1/models')) return Promise.resolve({ data: { data: downloaded.map((id) => ({ id })) } });
    return Promise.resolve({ data: {} });
  });
  const lemonade = new LemonadeBackend(mock<LoggerService>());
  await lemonade.healthCheck();
  return { registry: new ModelRegistryService(mock<LoggerService>(), lemonade), lemonade };
}

/** Whether 10.2.0 can supply a catalog Lemonade row: it lists it, or the Hub registers it on pull. */
const servableOn10_2_0 = (lemonade: LemonadeBackend, backendModelId: string) => lemonade.offersModel(backendModelId) === true;

describe('Lemonade catalog rows against the Lemonade the fleet runs (10.2.0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides exactly the 13 Lemonade LLM rows 10.2.0 cannot supply', async () => {
    const { registry } = await registryAgainst10_2_0();
    const offered = new Set(registry.getModelsForTier('high').map((m) => m.id));
    const hidden = CURATED_MODELS.filter((m) => m.backend === 'lemonade' && m.modality === 'llm' && !offered.has(m.id)).map((m) => m.backendModelId);

    // The list the audit read off beta-red's live `GET /v1/models?show_all=true`.
    expect(hidden.sort()).toEqual(
      [
        'Gemma-4-12B-it-GGUF',
        'Gemma-4-26B-A4B-it-MTP-GGUF',
        'Qwen3.8-27B-GGUF',
        'Qwen3.6-27B-GGUF',
        'Qwen3.6-27B-MTP-GGUF',
        'Qwen3.6-35B-A3B-GGUF',
        'Qwen3.6-35B-A3B-MTP-GGUF',
        'Qwen3.5-122B-A10B-GGUF',
        'gpt-oss-120b-mxfp-GGUF',
        'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF',
        'Muse-Glimmer-30B-GGUF',
        'LFM2.5-8B-A1B',
        'Llama-4-Scout-17B-16E-Instruct-GGUF',
      ].sort(),
    );
  });

  it('keeps every Lemonade voice and embedding row servable there', async () => {
    const { registry, lemonade } = await registryAgainst10_2_0();
    const offered = registry.getModelsForTier('high').filter((m) => m.backend === 'lemonade' && m.modality !== 'llm');

    expect(offered.map((m) => m.id).sort()).toEqual(
      ['kokoro-v1', 'nomic-embed-text-v1-5-lemonade', 'nomic-embed-text-v1-lemonade', 'whisper-base', 'whisper-large-v3-turbo'].sort(),
    );
    for (const model of offered) expect(servableOn10_2_0(lemonade, model.backendModelId)).toBe(true);
  });

  for (const [name, hw] of Object.entries(FLEET_PROFILES)) {
    it(`hands a Lemonade node on ${name} only defaults 10.2.0 can serve`, async () => {
      const { registry, lemonade } = await registryAgainst10_2_0();
      const chat = registry.getRecommendedModelsForHardware(hw.tier, hw).filter((m) => m.backend === 'lemonade' && m.modality === 'llm');
      const vision = registry.getRecommendedVisionModel(hw.tier, 'lemonade', hw);
      const embedder = registry.getRecommendedEmbeddingModel(hw.tier, 'lemonade', hw);

      expect(chat.length).toBeGreaterThan(0);
      for (const model of [...chat, vision, embedder]) {
        expect(model, `${name}: a default is missing`).toBeTruthy();
        expect(servableOn10_2_0(lemonade, model?.backendModelId ?? ''), `${name}: ${model?.backendModelId}`).toBe(true);
      }
      // What #1679 picked here: none of it exists in 10.2.0.
      const picked = [...chat, vision].map((m) => m?.backendModelId);
      for (const unservable of ['Gemma-4-12B-it-GGUF', 'Qwen3.8-27B-GGUF', 'Qwen3.6-35B-A3B-GGUF']) {
        expect(picked).not.toContain(unservable);
      }
    });
  }

  it('filters nothing while Lemonade has not been read, as before', () => {
    const registry = new ModelRegistryService(mock<LoggerService>(), new LemonadeBackend(mock<LoggerService>()));
    const lemonadeLlms = registry.getModelsForTier('high').filter((m) => m.backend === 'lemonade' && m.modality === 'llm');

    expect(lemonadeLlms.length).toBe(CURATED_MODELS.filter((m) => m.backend === 'lemonade' && m.modality === 'llm').length);
  });

  it('still resolves a hidden row by id, so a tracked model or preference naming one keeps its entry', async () => {
    const { registry } = await registryAgainst10_2_0();

    expect(registry.getCuratedModel('qwen3-8-27b-lemonade')?.backendModelId).toBe('Qwen3.8-27B-GGUF');
  });

  it('uses the listing the fixture records: 74 ids, none of them the 13 above', () => {
    expect(LEMONADE_10_2_0_SHOW_ALL_IDS).toHaveLength(74);
    expect(LEMONADE_10_2_0_SHOW_ALL_IDS).not.toContain('Qwen3.8-27B-GGUF');
  });
});
