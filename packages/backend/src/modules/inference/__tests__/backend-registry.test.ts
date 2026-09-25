import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { InferenceBackendRegistry, UnknownInferenceBackendError } from '../backends/backend-registry';
import type { InferenceBackend } from '../backends/backend.interface';
import { DsparkBackend } from '../backends/dspark.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { LlamacppBackend } from '../backends/llamacpp.backend';
import { LmStudioBackend } from '../backends/lmstudio.backend';
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
  llamacpp: make('llamacpp'),
  lmstudio: make('lmstudio'),
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
    backends.llamacpp as LlamacppBackend,
    backends.lmstudio as LmStudioBackend,
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

    it('throws a named error carrying the bad value and the valid set, for a type outside the union', () => {
      const registry = buildRegistry(makeBackends());

      // This test used to assert `get` *returned* undefined. That was written to characterize the
      // hazard, not to bless it: the compiler cannot police the callers that feed `get` values
      // sourced from data rather than from literals — settings.json read off disk and typed by
      // assertion, a curated catalog row in model-puller, a DB column in the pool proxy — so
      // undefined behind a non-optional return type surfaced three frames later as
      // `Cannot read properties of undefined (reading 'healthCheck')`, naming neither the bad value
      // nor the lookup that produced it. The lookup now fails at the boundary instead.
      //
      // The old comment's point still stands, and is why this is a throw rather than a
      // `?? this.lemonadeBackend` cushion: silently routing a retired backend name to Lemonade
      // would pull the wrong model. Absent wiring still reads as absent — it just says so on time.
      // Deliberately a name no engine in this repo has. It used to be 'llamacpp', which stopped
      // being a lie the day that backend was added — a fixture that quietly becomes valid turns
      // three "this must throw" assertions into three that pass for the wrong reason. Keep this
      // string fictional; if a `tensorrt-llm` backend is ever added, change it again.
      const staleCatalogValue: string = 'tensorrt-llm';

      expect(() => registry.get(staleCatalogValue as InferenceBackendType)).toThrow(UnknownInferenceBackendError);
      // Both halves of the message are load-bearing: the frame that catches this is never the frame
      // that produced the string, so the error has to carry the rejected value *and* the valid set.
      expect(() => registry.get(staleCatalogValue as InferenceBackendType)).toThrow(/'tensorrt-llm'/);
      expect(() => registry.get(staleCatalogValue as InferenceBackendType)).toThrow(new RegExp(INFERENCE_BACKEND_TYPES.join(', ')));
    });

    it('names itself and carries the rejected value on the error object, not only in the message prose', () => {
      const registry = buildRegistry(makeBackends());

      // The test above pins the human half of the contract; this pins the machine half, which no
      // message regex and no `instanceof` can reach. Every route out of the registry that does not
      // branch on `tryGet` ends at MainExceptionFilter as a 500, and that filter scrubs the response
      // body to `INTERNAL_SERVER_ERROR` — so the logged and Sentry-captured exception is the only
      // artifact left holding the bad value. Sentry groups that by `name`: without `this.name` the
      // class collapses into generic `Error` and the group is unreadable, and without the `readonly`
      // on the constructor parameter the only way back to the rejected string is re-parsing English.
      const staleCatalogValue: string = 'tensorrt-llm';

      let caught: unknown;
      try {
        registry.get(staleCatalogValue as InferenceBackendType);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UnknownInferenceBackendError);
      expect(caught).toMatchObject({ name: 'UnknownInferenceBackendError', requestedType: staleCatalogValue });
    });
  });

  describe('tryGet', () => {
    it.each([...INFERENCE_BACKEND_TYPES])('resolves %s to the same instance get returns', (type) => {
      const backends = makeBackends();
      const registry = buildRegistry(backends);

      // Anchored to the injected instance as well as to `get`, so a tryGet that read some other
      // map — or a `get` reimplemented off tryGet incorrectly — cannot pass by agreeing with itself.
      expect(registry.tryGet(type)).toBe(backends[type]);
      expect(registry.tryGet(type)).toBe(registry.get(type));
    });

    it('returns undefined for a type outside the union, so a caller can fall back deliberately', () => {
      const registry = buildRegistry(makeBackends());

      // The branch-instead-of-catch door for the two callers that resolve an operator preference
      // out of settings.json (app-credentials, inference-env-resolver). A stale value there must
      // degrade to Ollama with a warning rather than break credential/env resolution for every
      // installed app, and catching an exception to steer normal control flow reads worse.
      const staleSettingsValue: string = 'tensorrt-llm';

      expect(registry.tryGet(staleSettingsValue as InferenceBackendType)).toBeUndefined();
    });
  });

  describe('entries', () => {
    it('yields every type paired with its instance, in INFERENCE_BACKEND_TYPES order', () => {
      const backends = makeBackends();

      const expected = INFERENCE_BACKEND_TYPES.map((type) => [type, backends[type]] as const);
      expect(buildRegistry(backends).entries()).toStrictEqual(expected);
    });

    it('walks the source tuple, not the constructor record', async () => {
      // The record literal is written in tuple order, so `Object.entries(this.byType)` is
      // indistinguishable from the real walk under the real tuple. Only a tuple that disagrees with
      // the record can tell the two implementations apart, and a frozen `as const` export cannot be
      // reordered in place. Hence the re-import under a mock.
      const reordered = ['lucebox', 'mtplx', 'dspark', 'lemonade', 'vllm', 'ollama'] as const;

      vi.resetModules();
      vi.doMock('@ci-hub/common/types', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@ci-hub/common/types')>()),
        INFERENCE_BACKEND_TYPES: reordered,
      }));

      try {
        const { InferenceBackendRegistry: ReloadedRegistry } = await import('../backends/backend-registry');
        const backends = makeBackends();

        expect(buildRegistry(backends, ReloadedRegistry).entries()).toStrictEqual(reordered.map((type) => [type, backends[type]]));
      } finally {
        vi.doUnmock('@ci-hub/common/types');
        vi.resetModules();
      }
    });

    it('throws by name for a tuple type nobody wired into the constructor', async () => {
      // A seventh backend added to the union but not to the registry. entries() resolves through
      // get(), so the omission surfaces as a named error rather than an `undefined` the return type
      // says cannot be there. What it must never do is drop out of the walk silently — that is the
      // failure mode the hand-written literal arrays had, and the reason this derives from the tuple.
      // Unreachable in practice: the Record makes an unwired type a compile error. This is the
      // runtime tripwire behind that.
      const withUnwiredType = [...INFERENCE_BACKEND_TYPES, 'nemo'] as const;

      vi.resetModules();
      vi.doMock('@ci-hub/common/types', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@ci-hub/common/types')>()),
        INFERENCE_BACKEND_TYPES: withUnwiredType,
      }));

      try {
        const { InferenceBackendRegistry: ReloadedRegistry, UnknownInferenceBackendError } = await import('../backends/backend-registry');
        const registry = buildRegistry(makeBackends(), ReloadedRegistry);

        expect(() => registry.entries()).toThrow(UnknownInferenceBackendError);
        expect(() => registry.entries()).toThrow("Unknown inference backend 'nemo'");
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
          { provide: LlamacppBackend, useValue: backends.llamacpp },
          { provide: LmStudioBackend, useValue: backends.lmstudio },
        ],
      }).compile();

      // The only test that constructs the registry the way production does. `@Injectable()` and the
      // *value* imports of the backend classes are jointly what emit `design:paramtypes`; drop
      // either — the decorator, or a slip to `import type` — and Nest hands the constructor a row
      // of undefineds, so every lookup in every caller goes dark while the direct-construction
      // tests stay green.
      const registry = module.get(InferenceBackendRegistry);

      const expected = INFERENCE_BACKEND_TYPES.map((type) => [type, backends[type]] as const);
      expect(registry.entries()).toStrictEqual(expected);
    });
  });
});
