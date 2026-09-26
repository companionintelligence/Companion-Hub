import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { OmlxBackend } from '../backends/omlx.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { InferenceModule } from '../inference.module';

/**
 * Every backend class, paired with the type it answers for.
 *
 * Hand-written on purpose — it is the *other* side of `INFERENCE_BACKEND_TYPES`, and a test that
 * derived it from the same tuple could only agree with itself. The count assertion below is what
 * ties the two together.
 */
const BACKEND_CLASSES = [
  ['ollama', OllamaBackend],
  ['vllm', VllmBackend],
  ['lemonade', LemonadeBackend],
  ['omlx', OmlxBackend],
] as const;

const providersOf = (module: unknown): unknown[] => (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module as never) as unknown[]) ?? [];
const exportsOf = (module: unknown): unknown[] => (Reflect.getMetadata(MODULE_METADATA.EXPORTS, module as never) as unknown[]) ?? [];

/**
 * The gap the compiler cannot see.
 *
 * Adding a type to `INFERENCE_BACKEND_TYPES` is already a build error until the registry's `Record`
 * gains the entry — that tripwire works. What no build error covers is the Nest side: a backend
 * class the registry and the controller both inject, but which nobody listed in the module's
 * `providers`, resolves to `Nest can't resolve dependencies of the InferenceBackendRegistry` at
 * BOOT, long after every unit test has passed. `backend-registry.test.ts` compiles the registry
 * against an explicit provider list of its own, so it cannot catch this either.
 */
describe('InferenceModule wiring', () => {
  it('provides and exports every backend class', () => {
    const providers = providersOf(InferenceModule);
    const exported = exportsOf(InferenceModule);

    for (const [type, cls] of BACKEND_CLASSES) {
      expect(providers, `${type} is injected but not provided by InferenceModule`).toContain(cls);
      // McpModule and the pool import this module and resolve backends through it, so a provider
      // that is not exported is reachable here and nowhere else.
      expect(exported, `${type} is provided but not exported by InferenceModule`).toContain(cls);
    }
  });

  /* Keeps the list above honest: a new backend type must arrive with its class, not without one. */
  it('has one class for every declared backend type', () => {
    expect(BACKEND_CLASSES.map(([type]) => type)).toEqual([...INFERENCE_BACKEND_TYPES]);
  });
});
