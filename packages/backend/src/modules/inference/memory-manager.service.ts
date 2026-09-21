import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { HardwareProfile, MemoryBudget } from '@ci-hub/common/types';
import { ModelRegistryService } from './model-registry.service';

const SYSTEM_RESERVED_RAM_MB = 2048;
const DOCKER_OVERHEAD_PER_CONTAINER_MB = 500;

@Injectable()
export class MemoryManagerService {
  private runningAppContainerCount = 0;

  constructor(
    readonly _logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
  ) {}

  /** Set the number of running app containers (updated by app lifecycle) */
  setRunningAppCount(count: number): void {
    this.runningAppContainerCount = count;
  }

  /** Calculate current memory budget */
  calculateBudget(profile: HardwareProfile): MemoryBudget {
    const totalVramMb = profile.gpu.unifiedMemory ? 0 : profile.gpu.available ? profile.gpu.vramMb : 0;
    const totalRamMb = profile.ram.totalMb;

    const dockerOverheadMb = this.runningAppContainerCount * DOCKER_OVERHEAD_PER_CONTAINER_MB;
    const appContainerBudgetMb = dockerOverheadMb;

    const modelBudgetVramMb = Math.max(0, totalVramMb - 512); // Reserve 512 MB VRAM for display
    const modelBudgetRamMb = Math.max(0, totalRamMb - SYSTEM_RESERVED_RAM_MB - appContainerBudgetMb);

    // Sum memory of loaded/pinned models
    const loadedModels = this.modelRegistry.getLoadedModels();
    let modelUsedVramMb = 0;
    let modelUsedRamMb = 0;
    let pinnedVramMb = 0;
    let pinnedRamMb = 0;

    for (const model of loadedModels) {
      if (profile.gpu.unifiedMemory || !profile.gpu.available) {
        // CPU or unified: models use RAM
        modelUsedRamMb += model.memoryUsedMb;
        if (model.pinned) pinnedRamMb += model.memoryUsedMb;
      } else {
        // Discrete GPU: models use VRAM
        modelUsedVramMb += model.memoryUsedMb;
        if (model.pinned) pinnedVramMb += model.memoryUsedMb;
      }
    }

    return {
      totalVramMb,
      totalRamMb,
      systemReservedRamMb: SYSTEM_RESERVED_RAM_MB,
      dockerOverheadMb,
      appContainerBudgetMb,
      modelBudgetVramMb,
      modelBudgetRamMb,
      modelUsedVramMb,
      modelUsedRamMb,
      pinnedVramMb,
      pinnedRamMb,
    };
  }

  /**
   * RAM a new model may take right now: the registry's view of the budget (total minus reserve,
   * app overhead and the models it knows it loaded) capped by what the host actually has free.
   *
   * The registry only knows about models the Hub loaded. On a unified-memory node everything
   * else that lives in the same pool — vLLM holding 96 GB of GTT out-of-band, a model Ollama
   * kept resident past the registry's record, the apps themselves — is invisible to it, and the
   * budget alone admitted a load the host could not take (Ollama OOM-killed on `ci`).
   * `profile.ram.availableMb` is MemAvailable read live by the hardware inspector on a Linux
   * host (`ram.sampledAt` says so), so the cap follows the host; the system reserve comes off
   * it the same as off the total. On macOS/Windows the figure is the desktop probe's snapshot
   * from app start — `vm_stat` free+inactive, routinely a fraction of RAM the OS would hand
   * over on demand — and it never recovers, so it must not cap anything.
   */
  private ramHeadroomMb(profile: HardwareProfile, budget: MemoryBudget): number {
    const budgeted = budget.modelBudgetRamMb - budget.modelUsedRamMb;
    if (!profile.ram.sampledAt) {
      return budgeted;
    }
    const live = Math.max(0, profile.ram.availableMb - SYSTEM_RESERVED_RAM_MB);
    return Math.min(budgeted, live);
  }

  /** Check if a model can fit in the current memory budget */
  canFitModel(profile: HardwareProfile, memoryFootprintMb: number): { fits: boolean; availableMb: number; requiredMb: number } {
    const budget = this.calculateBudget(profile);

    let availableMb: number;
    if (profile.gpu.unifiedMemory || !profile.gpu.available) {
      availableMb = this.ramHeadroomMb(profile, budget);
    } else {
      availableMb = budget.modelBudgetVramMb - budget.modelUsedVramMb;
    }

    return {
      fits: availableMb >= memoryFootprintMb,
      availableMb,
      requiredMb: memoryFootprintMb,
    };
  }

  /** Determine which models to evict to free the required memory */
  getModelsToEvict(_profile: HardwareProfile, requiredMb: number): { canFree: boolean; modelsToEvict: string[]; freedMb: number } {
    const candidates = this.modelRegistry.getEvictionCandidates();
    const modelsToEvict: string[] = [];
    let freedMb = 0;

    for (const candidate of candidates) {
      if (freedMb >= requiredMb) break;
      modelsToEvict.push(candidate.catalogId);
      freedMb += candidate.memoryUsedMb;
    }

    return {
      canFree: freedMb >= requiredMb,
      modelsToEvict,
      freedMb,
    };
  }

  /** Check if an app can start given the current memory state */
  canStartApp(profile: HardwareProfile, appMemoryMb: number): { canStart: boolean; modelsToEvict: string[]; warning?: string } {
    const budget = this.calculateBudget(profile);
    const remainingRam = this.ramHeadroomMb(profile, budget);

    if (remainingRam >= appMemoryMb) {
      return { canStart: true, modelsToEvict: [] };
    }

    // Need to evict unpinned models
    const deficit = appMemoryMb - remainingRam;
    const eviction = this.getModelsToEvict(profile, deficit);

    if (eviction.canFree) {
      return {
        canStart: true,
        modelsToEvict: eviction.modelsToEvict,
        warning: `Starting this app will evict ${eviction.modelsToEvict.length} model(s) from memory`,
      };
    }

    // Would need to evict pinned models — deny
    return {
      canStart: false,
      modelsToEvict: [],
      warning: `Insufficient memory. ${appMemoryMb} MB required but only ${remainingRam + eviction.freedMb} MB available (pinned models cannot be evicted)`,
    };
  }

  /** Check if pinning a new model would exceed the budget */
  canPinModel(profile: HardwareProfile, memoryFootprintMb: number): { canPin: boolean; reason?: string } {
    const budget = this.calculateBudget(profile);

    if (profile.gpu.unifiedMemory || !profile.gpu.available) {
      const totalPinnedAfter = budget.pinnedRamMb + memoryFootprintMb;
      if (totalPinnedAfter > budget.modelBudgetRamMb) {
        return { canPin: false, reason: `Pinning would use ${totalPinnedAfter} MB but only ${budget.modelBudgetRamMb} MB available for models` };
      }
    } else {
      const totalPinnedAfter = budget.pinnedVramMb + memoryFootprintMb;
      if (totalPinnedAfter > budget.modelBudgetVramMb) {
        return { canPin: false, reason: `Pinning would use ${totalPinnedAfter} MB VRAM but only ${budget.modelBudgetVramMb} MB available` };
      }
    }

    return { canPin: true };
  }
}
