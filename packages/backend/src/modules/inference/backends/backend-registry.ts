import { Injectable } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
// Value imports, not `import type`: Nest resolves these constructor params through
// emitDecoratorMetadata's design:paramtypes, and a type-only import erases them to undefined.
import { DsparkBackend } from './dspark.backend';
import { LemonadeBackend } from './lemonade.backend';
import { LuceboxBackend } from './lucebox.backend';
import { MtplxBackend } from './mtplx.backend';
import { OllamaBackend } from './ollama.backend';
import { VllmBackend } from './vllm.backend';

/**
 * The single type-to-backend mapping for the inference module.
 *
 * Deliberately a `Record` keyed by the `InferenceBackendType` union rather than a `Map` or a
 * ternary chain. An earlier `backend === 'ollama' ? … : backend === 'vllm' ? … : this.lemonadeBackend`
 * shape silently handed back Lemonade for any newly added backend type, and the compiler could not
 * see it. A `Record` over the closed union makes a missing entry a build error instead, and unlike
 * an index signature it is not widened to `| undefined` by `noUncheckedIndexedAccess`.
 *
 * This replaces five byte-identical private `getBackend` switches that had drifted into
 * model-puller, inference-env-resolver, inference-router, app-credentials, and the controller.
 */
@Injectable()
export class InferenceBackendRegistry {
  private readonly byType: Record<InferenceBackendType, InferenceBackend>;

  constructor(
    ollama: OllamaBackend,
    vllm: VllmBackend,
    lemonade: LemonadeBackend,
    mtplx: MtplxBackend,
    dspark: DsparkBackend,
    lucebox: LuceboxBackend,
  ) {
    this.byType = {
      ollama,
      vllm,
      lemonade,
      mtplx,
      dspark,
      lucebox,
    };
  }

  get(type: InferenceBackendType): InferenceBackend {
    return this.byType[type];
  }
}
