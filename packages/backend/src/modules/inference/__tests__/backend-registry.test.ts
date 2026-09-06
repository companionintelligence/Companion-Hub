import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { InferenceBackend } from '../backends/backend.interface';
import { DsparkBackend } from '../backends/dspark.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';

/**
 * A stand-in for one injected backend, identified only by the URL it hands back.
 *
 * Deliberately carries no `type` property: the real doubles these model are `mock<OllamaBackend>()`
 * proxies whose `type` reads as undefined, and the registry's contract is that it never sources a
 * type from the instance. `getBaseUrl` gives each stand-in a distinct identity that shows up in
 * assertion diffs, so a mis-wired key names itself instead of printing `{}` twice.
 */
const standIn = (name: string): InferenceBackend => ({ getBaseUrl: () => `http://${name}:0` }) as InferenceBackend;

/** Like {@link standIn}, but the instance lies about its own type. */
const mislabelledStandIn = (name: string, claimedType: InferenceBackendType): InferenceBackend =>
  ({ type: claimedType, getBaseUrl: () => `http://${name}:0` }) as InferenceBackend;

type BackendsByType = Record<InferenceBackendType, InferenceBackend>;

const makeBackends = (make: (name: InferenceBackendType) => InferenceBackend = standIn): BackendsByType => ({
  ollama: make('ollama'),
  vllm: make('vllm'),
  lemonade: make('lemonade'),
  mtplx: make('mtplx'),
  dspark: make('dspark'),
  lucebox: make('lucebox'),
});

/**
 * Feeds the stand-ins through the real constructor in its declared positional order, so a reordered
 * or duplicated constructor parameter surfaces as a failing pairing rather than compiling silently.
 *
 * Takes the class as a parameter so the tuple-derivation case below can drive a copy of the module
 * re-imported against a mocked `INFERENCE_BACKEND_TYPES`.
 */
const buildRegistry = (backends: BackendsByType, Registry = InferenceBackendRegistry): InferenceBackendRegistry =>
  new Registry(
    backends.ollama as OllamaBackend,
    backends.vllm as VllmBackend,
    backends.lemonade as LemonadeBackend,
    backends.mtplx as MtplxBackend,
    backends.dspark as DsparkBackend,
    backends.lucebox as LuceboxBackend,
  );

describe('InferenceBackendRegistry', () => {
  describe('get', () => {
    it.each([...INFERENCE_BACKEND_TYPES])('resolves %s to the instance injected for that type', (type) => {
      const backends = makeBackends();

      expect(buildRegistry(backends).get(type)).toBe(backends[type]);
    });

    it('resolves each type to a distinct instance, so no key is wired to a neighbour', () => {
      const registry = buildRegistry(makeBackends());

      // A `Record` makes a *missing* key a build error, but `dspark: mtplx` — the copy-paste that
      // the five deleted switches were prone to — still type-checks. Only distinctness catches it.
      const resolved = INFERENCE_BACKEND_TYPES.map((type) => registry.get(type));
      expect(new Set(resolved).size).toBe(INFERENCE_BACKEND_TYPES.length);
    });

    it('returns undefined for a type outside the union instead of falling back to a default backend', () => {
      const registry = buildRegistry(makeBackends());

      // The compiler cannot police the callers that feed `get` values sourced from data rather than
      // from literals — a curated catalog row in model-puller, a request body in the MCP tools, a DB
      // column in the pool proxy. A `?? this.lemonadeBackend` cushion would route a stale or retired
      // backend name to Lemonade and pull the wrong model: exactly the silent misroute the ternary
      // chain used to cause. Absent wiring has to read as absent.
      const staleCatalogValue: string = 'llamacpp';
      expect(registry.get(staleCatalogValue as InferenceBackendType)).toBeUndefined();
    });
  });

  describe('entries', () => {
    it('yields every type paired with its instance, in INFERENCE_BACKEND_TYPES order', () => {
      const backends = makeBackends();

      const expected = INFERENCE_BACKEND_TYPES.map((type) => [type, backends[type]] as const);
      expect(buildRegistry(backends).entries()).toStrictEqual(expected);
    });

    it('walks the source tuple, not the constructor record, so an unwired new type still surfaces', async () => {
      // The record literal is written in tuple order, so `Object.entries(this.byType)` is
      // indistinguishable from the real walk under the real tuple. Only a tuple that disagrees with
      // the record — reordered, and one type longer — can tell the two implementations apart, and a
      // frozen `as const` export cannot be reordered in place. Hence the re-import under a mock.
      const reorderedWithNewType = ['lucebox', 'mtplx', 'dspark', 'lemonade', 'vllm', 'ollama', 'nemo'] as const;

      vi.resetModules();
      vi.doMock('@ci-hub/common/types', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@ci-hub/common/types')>()),
        INFERENCE_BACKEND_TYPES: reorderedWithNewType,
      }));

      try {
        const { InferenceBackendRegistry: ReloadedRegistry } = await import('../backends/backend-registry');
        const backends = makeBackends();

        expect(buildRegistry(backends, ReloadedRegistry).entries()).toStrictEqual([
          ['lucebox', backends.lucebox],
          ['mtplx', backends.mtplx],
          ['dspark', backends.dspark],
          ['lemonade', backends.lemonade],
          ['vllm', backends.vllm],
          ['ollama', backends.ollama],
          // The seventh backend nobody wired into the constructor. It has to land here as a loud
          // unwired pair; dropping out of the walk is the failure mode the six hand-written literal
          // arrays had, and the whole reason this method derives itself from the tuple.
          ['nemo', undefined],
        ]);
      } finally {
        vi.doUnmock('@ci-hub/common/types');
        vi.resetModules();
      }
    });

    it('agrees with get for every type, and both agree with the instance that was injected', () => {
      const backends = makeBackends();
      const registry = buildRegistry(backends);

      // Cross-checking the two accessors against each other passes whenever both are wrong in the
      // same direction, so each pair is also anchored to the instance handed to the constructor.
      for (const [type, backend] of registry.entries()) {
        expect(backend).toBe(registry.get(type));
        expect(backend).toBe(backends[type]);
      }
    });

    it('never sources the type from the instance, which for a real test double has none', () => {
      const backends = makeBackends();

      // Guards the premise of this test: reading `backend.type` here would yield undefined six times.
      for (const type of INFERENCE_BACKEND_TYPES) {
        expect('type' in backends[type]).toBe(false);
      }

      const entries = buildRegistry(backends).entries();
      expect(entries.map(([type]) => type)).toEqual([...INFERENCE_BACKEND_TYPES]);
    });

    it('never sources the type from the instance, not even one that reports a wrong but plausible type', () => {
      // Every stand-in claims to be lucebox. A defined-but-wrong `type` is the case the undefined-type
      // double above cannot catch: `backend.type` would produce six plausible strings, all of them wrong.
      const backends = makeBackends((name) => mislabelledStandIn(name, 'lucebox'));
      const registry = buildRegistry(backends);

      const entries = registry.entries();
      expect(entries.map(([type]) => type)).toEqual([...INFERENCE_BACKEND_TYPES]);
      expect(entries.map(([, backend]) => backend.getBaseUrl())).toEqual(INFERENCE_BACKEND_TYPES.map((type) => `http://${type}:0`));
    });
  });

  describe('nest wiring', () => {
    it('resolves through the injector with each constructor parameter bound to its backend class token', async () => {
      const backends = makeBackends();

      const module = await Test.createTestingModule({
        providers: [
          InferenceBackendRegistry,
          { provide: OllamaBackend, useValue: backends.ollama },
          { provide: VllmBackend, useValue: backends.vllm },
          { provide: LemonadeBackend, useValue: backends.lemonade },
          { provide: MtplxBackend, useValue: backends.mtplx },
          { provide: DsparkBackend, useValue: backends.dspark },
          { provide: LuceboxBackend, useValue: backends.lucebox },
        ],
      }).compile();

      // The only test that constructs the registry the way production does. `@Injectable()` and the
      // *value* imports of the six classes are jointly what emit `design:paramtypes`; drop either —
      // the decorator, or a slip to `import type` — and Nest hands the constructor six undefineds,
      // so every lookup in every caller goes dark while the direct-construction tests stay green.
      const registry = module.get(InferenceBackendRegistry);

      const expected = INFERENCE_BACKEND_TYPES.map((type) => [type, backends[type]] as const);
      expect(registry.entries()).toStrictEqual(expected);
    });
  });
});
