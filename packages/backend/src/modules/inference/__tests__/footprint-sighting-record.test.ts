import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from '@ci-hub/common/types';
import {
  FOOTPRINT_SIGHTINGS_PATH,
  readFootprintSightings,
  type RecordedSighting,
  sightingHardware,
  sightingMovedMaterially,
  writeFootprintSightings,
} from '../footprint-sighting-record';

const betaRed: HardwareProfile = {
  gpu: {
    available: true,
    vendor: 'nvidia',
    model: 'GeForce RTX 3080',
    vramMb: 10_240,
    unifiedMemory: false,
    driverVersion: '',
    runtimeAvailable: true,
  },
  npu: { available: false, model: '' },
  ram: { totalMb: 32_000, availableMb: 29_000 },
  cpu: { arch: 'x86_64', cores: 16, model: 'x' },
  effectiveInferenceMemoryMb: 10_240,
  tier: 'high',
};

const gemma: RecordedSighting = {
  backend: 'ollama',
  model: 'gemma4:e4b',
  footprintMb: 5550,
  contextLength: 16_384,
  source: 'process',
  seenAt: '2026-09-29T00:00:00.000Z',
};

describe('footprint sighting record', () => {
  it('round-trips through the state file', async () => {
    await writeFootprintSightings({ hardware: sightingHardware(betaRed), sightings: [gemma] });
    await expect(readFootprintSightings()).resolves.toEqual({ hardware: sightingHardware(betaRed), sightings: [gemma] });
  });

  it('reads a missing, torn or foreign file as nothing, and drops entries that are not sightings', async () => {
    await expect(readFootprintSightings()).resolves.toBeNull();

    await fs.promises.writeFile(FOOTPRINT_SIGHTINGS_PATH, '{"hardware": "vram|nvidia', 'utf8');
    await expect(readFootprintSightings()).resolves.toBeNull();

    await fs.promises.writeFile(FOOTPRINT_SIGHTINGS_PATH, JSON.stringify([gemma]), 'utf8');
    await expect(readFootprintSightings()).resolves.toBeNull();

    const junk = [
      { ...gemma, backend: 'llamafile' },
      { ...gemma, footprintMb: 0 },
      { ...gemma, contextLength: -1 },
      { ...gemma, source: 'registry' },
      { ...gemma, model: '' },
      null,
    ];
    await fs.promises.writeFile(FOOTPRINT_SIGHTINGS_PATH, JSON.stringify({ hardware: 'h', sightings: [...junk, gemma] }), 'utf8');
    await expect(readFootprintSightings()).resolves.toEqual({ hardware: 'h', sightings: [gemma] });
  });

  it('names the card a sighting holds for, to the GiB, and the machine on unified memory or CPU', () => {
    expect(sightingHardware(betaRed)).toBe('vram|nvidia|GeForce RTX 3080|10GiB');
    // A driver that reports a few MB less is the same card.
    expect(sightingHardware({ ...betaRed, gpu: { ...betaRed.gpu, vramMb: 10_200 } })).toBe(sightingHardware(betaRed));
    // beta-3-glass's 8 GB card is not.
    expect(sightingHardware({ ...betaRed, gpu: { ...betaRed.gpu, model: 'GeForce RTX 3070', vramMb: 8_192 } })).not.toBe(sightingHardware(betaRed));
    const strixHalo = {
      ...betaRed,
      gpu: { ...betaRed.gpu, vendor: 'amd', model: 'Radeon 8060S', unifiedMemory: true, vramMb: 124_124 },
      ram: { totalMb: 124_124, availableMb: 0 },
    };
    expect(sightingHardware(strixHalo)).toBe('ram|amd|Radeon 8060S|121GiB');
  });

  it('writes again only for a sighting that moved enough for the sizing to tell apart', () => {
    const seen = { footprintMb: 5550, contextLength: 16_384, source: 'process' as const };
    expect(sightingMovedMaterially(undefined, seen)).toBe(true);
    // A process figure drifting by a few MB between samples.
    expect(sightingMovedMaterially(seen, { ...seen, footprintMb: 5590 })).toBe(false);
    expect(sightingMovedMaterially(seen, { ...seen, footprintMb: 5700 })).toBe(true);
    expect(sightingMovedMaterially(seen, { ...seen, contextLength: 32_768 })).toBe(true);
    expect(sightingMovedMaterially(seen, { ...seen, source: 'engine' })).toBe(true);
  });
});
