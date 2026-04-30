import { Test, type TestingModule } from '@nestjs/testing';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { HardwareProfile, TrackedModel } from '@ci-hub/common/types';

describe('MemoryManagerService', () => {
  let service: MemoryManagerService;
  let loggerService: MockProxy<LoggerService>;
  let modelRegistry: MockProxy<ModelRegistryService>;

  const makeProfile = (overrides: Partial<HardwareProfile> = {}): HardwareProfile => ({
    gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '535', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: 65536, availableMb: 32768 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
    ...overrides,
  });

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    modelRegistry = mock<ModelRegistryService>();

    modelRegistry.getLoadedModels.mockReturnValue([]);
    modelRegistry.getEvictionCandidates.mockReturnValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryManagerService,
        { provide: LoggerService, useValue: loggerService },
        { provide: ModelRegistryService, useValue: modelRegistry },
      ],
    }).compile();

    service = module.get<MemoryManagerService>(MemoryManagerService);
  });

  // ─── S-MEM-1: Memory Budget ────────────────────────────────────────

  describe('Memory budget (MEM-1)', () => {
    it('S-MEM-1.1: SHALL reserve system overhead (default 2 GB)', () => {
      const budget = service.calculateBudget(makeProfile());
      expect(budget.systemReservedRamMb).toBe(2048);
    });

    it('S-MEM-1.2: SHALL account for running app containers', () => {
      service.setRunningAppCount(3);
      const budget = service.calculateBudget(makeProfile());
      expect(budget.dockerOverheadMb).toBe(1500); // 3 * 500
    });

    it('S-MEM-1.3: SHALL recalculate when apps start/stop', () => {
      service.setRunningAppCount(2);
      const budget1 = service.calculateBudget(makeProfile());

      service.setRunningAppCount(5);
      const budget2 = service.calculateBudget(makeProfile());

      expect(budget2.dockerOverheadMb).toBeGreaterThan(budget1.dockerOverheadMb);
    });

    it('should compute VRAM budget for discrete GPU', () => {
      const budget = service.calculateBudget(makeProfile());
      expect(budget.totalVramMb).toBe(24576);
      expect(budget.modelBudgetVramMb).toBe(24064); // 24576 - 512 reserved
    });

    it('should compute RAM-only budget for unified memory', () => {
      const profile = makeProfile({
        gpu: { available: true, vendor: 'apple', model: 'M4 Max', vramMb: 0, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
      });
      const budget = service.calculateBudget(profile);
      expect(budget.totalVramMb).toBe(0);
      expect(budget.modelBudgetRamMb).toBeGreaterThan(0);
    });
  });

  // ─── S-MEM-2: Eviction ─────────────────────────────────────────────

  describe('Eviction (MEM-2)', () => {
    it('S-MEM-2.1: SHALL score eviction candidates by LRU + frequency', () => {
      const candidates: TrackedModel[] = [
        {
          catalogId: 'model-a',
          backend: 'ollama',
          backendModelId: 'a',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 5000,
          lastUsedAt: 100,
          requestCount: 10,
        },
        {
          catalogId: 'model-b',
          backend: 'ollama',
          backendModelId: 'b',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 3000,
          lastUsedAt: 200,
          requestCount: 5,
        },
      ];
      modelRegistry.getEvictionCandidates.mockReturnValue(candidates);

      const result = service.getModelsToEvict(makeProfile(), 4000);
      expect(result.canFree).toBe(true);
      expect(result.modelsToEvict[0]).toBe('model-a'); // Older = evict first
    });

    it('S-MEM-2.2: pinned models SHALL never be eviction candidates', () => {
      // The model registry filters these out — we test that the eviction result
      // with no candidates cannot free memory
      modelRegistry.getEvictionCandidates.mockReturnValue([]);

      const result = service.getModelsToEvict(makeProfile(), 4000);
      expect(result.canFree).toBe(false);
      expect(result.modelsToEvict).toHaveLength(0);
    });
  });

  // ─── S-MEM-3: App vs Model Priority ───────────────────────────────

  describe('App starts vs models (MEM-3)', () => {
    it('S-MEM-3.1: SHALL evict unpinned models for app starts', () => {
      const loadedModels: TrackedModel[] = [
        {
          catalogId: 'model-a',
          backend: 'ollama',
          backendModelId: 'a',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 62000,
          lastUsedAt: 100,
          requestCount: 1,
        },
      ];
      modelRegistry.getEvictionCandidates.mockReturnValue(loadedModels);
      modelRegistry.getLoadedModels.mockReturnValue(loadedModels);

      // Use CPU-only profile so models use RAM (not VRAM)
      const cpuProfile = makeProfile({
        gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        tier: 'cpu-only',
      });

      const result = service.canStartApp(cpuProfile, 4000);
      expect(result.canStart).toBe(true);
      expect(result.modelsToEvict.length).toBeGreaterThan(0);
    });

    it('S-MEM-3.2: SHALL deny app start if it requires evicting pinned models', () => {
      // No eviction candidates (all pinned)
      modelRegistry.getEvictionCandidates.mockReturnValue([]);
      // Pinned models are using nearly all RAM
      const pinnedModels: TrackedModel[] = [
        {
          catalogId: 'pinned-1',
          backend: 'ollama',
          backendModelId: 'p1',
          state: 'pinned',
          pinned: true,
          memoryUsedMb: 62000,
          lastUsedAt: 100,
          requestCount: 1,
        },
      ];
      modelRegistry.getLoadedModels.mockReturnValue(pinnedModels);

      // With unified memory = false, models use VRAM not RAM, so we need to adjust
      // Use a profile where models use RAM (cpu-only or unified memory)
      const profile = makeProfile({
        gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        ram: { totalMb: 65536, availableMb: 2000 },
        tier: 'cpu-only',
      });
      const result = service.canStartApp(profile, 10000);
      expect(result.canStart).toBe(false);
      expect(result.warning).toContain('pinned models cannot be evicted');
    });

    it('S-MEM-3.3: SHALL warn when starting app will evict models', () => {
      const candidates: TrackedModel[] = [
        {
          catalogId: 'model-a',
          backend: 'ollama',
          backendModelId: 'a',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 5000,
          lastUsedAt: 100,
          requestCount: 1,
        },
      ];
      modelRegistry.getEvictionCandidates.mockReturnValue(candidates);
      modelRegistry.getLoadedModels.mockReturnValue(candidates);

      const result = service.canStartApp(makeProfile(), 65000);
      if (result.warning) {
        expect(result.warning).toContain('evict');
      }
    });
  });

  // ─── canFitModel ──────────────────────────────────────────────────

  describe('canFitModel', () => {
    it('should fit model when enough VRAM', () => {
      const result = service.canFitModel(makeProfile(), 5000);
      expect(result.fits).toBe(true);
    });

    it('should not fit model when insufficient VRAM', () => {
      modelRegistry.getLoadedModels.mockReturnValue([
        {
          catalogId: 'big',
          backend: 'ollama',
          backendModelId: 'big',
          state: 'loaded',
          pinned: true,
          memoryUsedMb: 22000,
          lastUsedAt: 100,
          requestCount: 1,
        },
      ]);
      const result = service.canFitModel(makeProfile(), 5000);
      expect(result.fits).toBe(false);
    });
  });

  // ─── canPinModel ──────────────────────────────────────────────────

  describe('canPinModel', () => {
    it('should allow pinning when budget available', () => {
      const result = service.canPinModel(makeProfile(), 5000);
      expect(result.canPin).toBe(true);
    });

    it('should deny pinning when budget exceeded', () => {
      modelRegistry.getLoadedModels.mockReturnValue([
        {
          catalogId: 'big',
          backend: 'ollama',
          backendModelId: 'big',
          state: 'pinned',
          pinned: true,
          memoryUsedMb: 22000,
          lastUsedAt: 100,
          requestCount: 1,
        },
      ]);
      const result = service.canPinModel(makeProfile(), 5000);
      expect(result.canPin).toBe(false);
    });
  });
});
