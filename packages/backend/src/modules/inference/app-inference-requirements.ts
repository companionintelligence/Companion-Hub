import type { CuratedModel } from '@ci-hub/common/types';

/**
 * What an installed app needs from the chat model it is handed, beyond "it answers".
 *
 * A model that fails one of these does not degrade an app — it stops it. On core-4 (2026-09-17)
 * both agents were handed `gemma3:1b`: OpenClaw sends tool definitions on every turn and the model
 * has no tool support, and Hermes aborts at startup on its 32K window. The Hub logged "hermes-agent
 * may refuse to start" and handed the model out anyway, while a peer one hop away served
 * `qwen3-coder:30b`, which meets both. Every handout path therefore filters on this table first.
 */
export interface AppInferenceRequirements {
  /**
   * Smallest context window, in tokens, the app accepts.
   *
   * hermes-agent: upstream Hermes Agent rejects anything below its MINIMUM_CONTEXT_LENGTH, which is
   * the literal 64000 (not 65536) compared with a strict `<`, so 64000 itself is accepted.
   */
  minContextLength?: number;
  /** The app sends `tools` on its chat requests, and an engine refuses those for a model without tool support. */
  toolCalling?: boolean;
}

const HERMES_REQUIREMENTS: AppInferenceRequirements = Object.freeze({ minContextLength: 64_000, toolCalling: true });
const OPENCLAW_REQUIREMENTS: AppInferenceRequirements = Object.freeze({ toolCalling: true });
/** CI-Mentra sends voice tools on its chat requests; replies are short, so no context floor. */
const CI_MENTRA_REQUIREMENTS: AppInferenceRequirements = Object.freeze({ toolCalling: true });

/**
 * Keyed by both names each agent goes by. `hermes-agent` and `openclaw` are the bootstrap slugs the
 * containers fetch `bootstrap.env` as, and the marketplace listings of the upstream images.
 * `ci-hermes` and `ci-openclaw` are the first-party listings, and they are what core-4 actually runs
 * (`docker ps`, 2026-09-17). Their `app.env` is generated under that installed name, so a table
 * keyed only by slug left the fleet's own agents with no requirements on that path.
 */
const APP_INFERENCE_REQUIREMENTS: Record<string, AppInferenceRequirements> = {
  'hermes-agent': HERMES_REQUIREMENTS,
  'ci-hermes': HERMES_REQUIREMENTS,
  openclaw: OPENCLAW_REQUIREMENTS,
  'ci-openclaw': OPENCLAW_REQUIREMENTS,
  'ci-mentra': CI_MENTRA_REQUIREMENTS,
  mentra: CI_MENTRA_REQUIREMENTS,
};

const NO_REQUIREMENTS: AppInferenceRequirements = Object.freeze({});

/** The app's requirements, or an empty set for an app that declares none. */
export function appInferenceRequirements(slug: string | null | undefined): AppInferenceRequirements {
  // Own-property check so a slug colliding with an Object.prototype member ("toString",
  // "__proto__") cannot return a function or the prototype itself.
  if (!slug || !Object.hasOwn(APP_INFERENCE_REQUIREMENTS, slug)) return NO_REQUIREMENTS;
  return APP_INFERENCE_REQUIREMENTS[slug] ?? NO_REQUIREMENTS;
}

export function hasInferenceRequirements(requirements: AppInferenceRequirements): boolean {
  return Boolean(requirements.toolCalling) || (requirements.minContextLength ?? 0) > 0;
}

/**
 * `meets` and `fails` are both answers from the catalog. `unverified` is a model the catalog has no
 * row for — an operator's own `vllm serve`, a tag pulled by hand — whose capabilities the Hub cannot
 * know. It is not a failure, and callers rank it below every model that is known to meet.
 */
export type RequirementVerdict = 'meets' | 'fails' | 'unverified';

export interface RequirementCheck {
  verdict: RequirementVerdict;
  /** Human-readable reasons for a `fails` verdict, such as "no tool calling". Empty otherwise. */
  unmet: string[];
}

export function checkModelRequirements(model: CuratedModel | null | undefined, requirements: AppInferenceRequirements): RequirementCheck {
  if (!hasInferenceRequirements(requirements)) {
    return { verdict: 'meets', unmet: [] };
  }
  if (!model) {
    return { verdict: 'unverified', unmet: [] };
  }
  const unmet: string[] = [];
  // `!== true`: every catalog LLM row carries an explicit tools flag, so an absent flag is a row that
  // was never verified to support tools, and handing it to a tool-calling app is the failure above.
  if (requirements.toolCalling && model.metadata?.capabilities?.tools !== true) {
    unmet.push('no tool calling');
  }
  const minContext = requirements.minContextLength ?? 0;
  if (minContext > 0 && !(model.runtime.contextWindow >= minContext)) {
    unmet.push(`${model.runtime.contextWindow}-token window (needs ${minContext})`);
  }
  return { verdict: unmet.length > 0 ? 'fails' : 'meets', unmet };
}

/** "tool calling and a 64000-token context window", for log lines and the error handed to an app. */
export function describeRequirements(requirements: AppInferenceRequirements): string {
  const parts: string[] = [];
  if (requirements.toolCalling) parts.push('tool calling');
  if (requirements.minContextLength) parts.push(`a context window of at least ${requirements.minContextLength} tokens`);
  return parts.join(' and ');
}
