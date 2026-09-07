import { Injectable } from '@nestjs/common';
import { INFERENCE_BACKEND_TYPES, type InferenceBackendType } from '@ci-hub/common/types';
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
 * Thrown when a lookup names a backend the Hub does not have.
 *
 * A distinct class, not a bare `Error`: the value almost always arrives from persisted state the
 * operator can edit (a retired or mistyped `inferenceBackend` in settings.json), so a caller that
 * wants to degrade rather than fail needs to tell this apart from a backend that threw while
 * genuinely trying to serve. The message carries both the rejected value and the valid set because
 * the frame that catches it is usually nowhere near the frame that produced the string.
 */
/**
 * Thrown when a backend type reaches the registry that is not in {@link INFERENCE_BACKEND_TYPES}.
 *
 * This is defense in depth, not a live failure mode. Every route into the registry is validated
 * today — HTTP through `inferenceBackendSchema`, settings.json through the `inferenceBackend` enum
 * in app.dto.ts, the pool proxy through the `X-Hub-Pool-Backend` header check, and model-puller
 * from a compile-time catalog constant. The throw exists so that if any of those is relaxed, or a
 * new caller arrives with an unvalidated string, the failure names the offending value here rather
 * than surfacing frames later as `Cannot read properties of undefined (reading 'healthCheck')`.
 */
export class UnknownInferenceBackendError extends Error {
  constructor(readonly requestedType: string) {
    super(`Unknown inference backend '${requestedType}'. Valid backends: ${INFERENCE_BACKEND_TYPES.join(', ')}.`);
    this.name = 'UnknownInferenceBackendError';
  }
}

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

  /**
   * The backend wired for `type`, or a thrown {@link UnknownInferenceBackendError}.
   *
   * The parameter type cannot police a caller that sources `type` from data rather than a literal.
   * The plain `this.byType[type]` this replaced handed such a caller `undefined` from behind a
   * non-optional return type, so the failure surfaced frames later with nothing naming the bad
   * value. Throwing makes the signature truthful. See {@link UnknownInferenceBackendError} for why
   * no caller can currently reach it.
   *
   * Callers that would rather branch than catch — anything resolving an operator preference that a
   * stale settings.json can invalidate — should use {@link tryGet} and fall back deliberately.
   */
  get(type: InferenceBackendType): InferenceBackend {
    const backend = this.tryGet(type);
    if (!backend) {
      throw new UnknownInferenceBackendError(type);
    }
    return backend;
  }

  /** {@link get} without the throw, for callers with a fallback of their own. */
  tryGet(type: InferenceBackendType): InferenceBackend | undefined {
    // The `Record` types this as `InferenceBackend`, but a caller can hand us any string; the
    // widened return type is what makes the miss visible instead of undefined-behind-a-type.
    return this.byType[type] as InferenceBackend | undefined;
  }

  /**
   * Every backend paired with its type, in {@link INFERENCE_BACKEND_TYPES} order.
   *
   * The counterpart to {@link get} for the callers that walk *all* backends rather than resolving
   * one. Those each kept their own six-element literal — `['ollama', …] as InferenceBackendType[]`
   * in the router, an array of the six injected instances in the MCP tools, `ALL_BACKEND_TYPES` in
   * the pool proxy — and every one of them was a subtype of `InferenceBackendType[]` however short
   * it got, so omitting a newly added backend was invisible to the compiler. Deriving the walk from
   * the source tuple makes the omission impossible rather than merely unlikely.
   *
   * Yields the type as a string from that tuple, never `backend.type` off the instance: test doubles
   * are `mock<OllamaBackend>()` proxies whose `type` property is undefined, so reading it would turn
   * a passing `backends.find((b) => b.type === 'ollama')` into a silent miss.
   */
  entries(): readonly (readonly [InferenceBackendType, InferenceBackend])[] {
    // Resolves through get(), so a type present in the tuple but absent from the constructor record
    // throws by name instead of yielding an `undefined` the return type says cannot be there — the
    // same lie get() was fixed for. Adding a type to the tuple without wiring it is already a
    // compile error on the Record, so this is the runtime tripwire behind that, not a live path.
    return INFERENCE_BACKEND_TYPES.map((type) => [type, this.get(type)] as const);
  }
}
