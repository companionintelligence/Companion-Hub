import { cn } from '@/lib/utils';
import type { CuratedModel } from '@ci-hub/common/types';
import type { ReactNode } from 'react';

/**
 * Iconography for the AI setup wizard.
 *
 * - {@link BrandLogo} renders an official brand SVG (hand-sourced into /public/brands) via a CSS
 *   mask, so it inherits the current text color (theme-adaptive) and stays crisp at any size.
 * - The hand-drawn line icons below cover Companion's own apps (OpenClaw, Hermes) and marks with no
 *   official logo (vLLM, Lemonade), plus the system-overview glyphs.
 *
 * Wrappers size the icon via `[&>*]:size-N` so both <svg> glyphs and <span> brand logos scale.
 */

interface IconProps {
  className?: string;
}

function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Official brand mark from /public/brands, colored with the current text color via a CSS mask. */
export function BrandLogo({ name, className }: { name: string; className?: string }) {
  const url = `/brands/${name}.svg`;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: `url("${url}")`,
        WebkitMaskImage: `url("${url}")`,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
      }}
    />
  );
}

/* ── Companion agent frameworks (own products — custom marks) ────────────────────────────────── */

// OpenClaw / Hermes use their official CI-Marketplace app-store logos (full-color raster), rendered as
// an <img>. Callers size them via a parent box (e.g. OptionCard's `[&>*]:size-11`) or an explicit
// className, and object-contain keeps the square logo crisp inside it.
export function OpenClawIcon({ className }: IconProps) {
  return <img src="/agents/openclaw.png" alt="OpenClaw" className={cn('rounded-md object-contain', className)} />;
}

export function HermesIcon({ className }: IconProps) {
  return <img src="/agents/hermes.png" alt="Hermes" className={cn('rounded-md object-contain', className)} />;
}

/* ── Inference backends without an official logo (custom marks) ──────────────────────────────── */

/** vLLM — a stylized V with a column. */
export function VllmIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4.5 7l4 10 4-10" />
      <path d="M17 7v10" />
      <path d="M15 7h4" />
    </Glyph>
  );
}

/** Lemonade — a citrus slice. */
export function LemonadeIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 3.8v16.4M3.8 12h16.4M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />
    </Glyph>
  );
}

/** A small spark for speculative decoding. */
export function SpeculativeInferenceIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5c.8 4.2 2.3 5.7 6.5 6.5-4.2.8-5.7 2.3-6.5 6.5-.8-4.2-2.3-5.7-6.5-6.5 4.2-.8 5.7-2.3 6.5-6.5Z" />
      <path d="M19 17v4M17 19h4M5 3v4M3 5h4" />
    </Glyph>
  );
}

/* ── Model labs without an official brand mark (custom marks) ────────────────────────────────── */
// These labs don't have a sourced SVG in /public/brands (unlike the CREATOR_BRAND set below, which
// are official marks). Rather than fetch third-party logo files we can't vet the provenance of, these
// follow the same hand-drawn convention already used for VllmIcon/LemonadeIcon above: a simple,
// original abstract mark, not a reproduction of any company's actual logo.

/** Z AI (Zhipu) — a bold Z. */
export function ZAiIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M6 6h12l-9.5 12H18" />
    </Glyph>
  );
}

/** Poolside — water ripples. */
export function PoolsideIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M3 9c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0" />
      <path d="M3 14.5c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0" />
    </Glyph>
  );
}

/** Deep Reinforce — a reinforcement-learning feedback loop. */
export function DeepReinforceIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1M19.5 12a7.5 7.5 0 0 1-13 5.1" />
      <path d="M17 4.5v3h-3M7 19.5v-3h3" />
    </Glyph>
  );
}

/** Liquid AI — a droplet. */
export function LiquidAiIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5c3.2 4 5.5 7.3 5.5 10.2a5.5 5.5 0 1 1-11 0c0-2.9 2.3-6.2 5.5-10.2Z" />
    </Glyph>
  );
}

/** Cohere — two overlapping circles. */
export function CohereIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="9.5" cy="12" r="6" />
      <circle cx="14.5" cy="12" r="6" />
    </Glyph>
  );
}

/** Thinking Machines — a spark. */
export function ThinkingMachinesIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5c.9 3.3 2.2 4.6 5.5 5.5-3.3.9-4.6 2.2-5.5 5.5-.9-3.3-2.2-4.6-5.5-5.5 3.3-.9 4.6-2.2 5.5-5.5Z" />
      <path d="M18.5 15.5c.4 1.4.9 1.9 2.3 2.3-1.4.4-1.9.9-2.3 2.3-.4-1.4-.9-1.9-2.3-2.3 1.4-.4 1.9-.9 2.3-2.3Z" />
    </Glyph>
  );
}

/* ── Models ──────────────────────────────────────────────────────────────────────────────────── */

/** Isometric cube — generic model fallback. */
function CubeIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3.2l8 4.2v8.6l-8 4.2-8-4.2V7.4l8-4.2Z" />
      <path d="M4.3 7.6 12 11.6l7.7-4M12 11.6v8.6" />
    </Glyph>
  );
}

/** Embedding model — a vector/latent-space mark (points + connecting edges). */
function EmbeddingIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <circle cx="6" cy="7" r="1.6" />
      <circle cx="18" cy="6" r="1.6" />
      <circle cx="17" cy="17" r="1.6" />
      <circle cx="7" cy="17.5" r="1.6" />
      <path d="M7.5 7.6 16.4 6.4M7.4 16.2 16.2 7.2M7 15.9V9M16.6 15.6 8.3 17.2" />
    </Glyph>
  );
}

/** Speech / audio model — a soundwave. */
function WaveIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M3 12h1.5M19.5 12H21" />
      <path d="M6.5 9v6M9.5 6.5v11M12 9.5v5M14.5 7.5v9M17.5 10v4" />
    </Glyph>
  );
}

// Brand mark by model creator (from catalog metadata) — preferred, since it's exact. Creators with
// no official brand SVG in /public/brands fall through to CREATOR_GLYPH, then a modality glyph.
const CREATOR_BRAND: Record<string, string> = {
  google: 'gemini',
  'google (community)': 'gemini',
  alibaba: 'qwen',
  meta: 'meta',
  nvidia: 'nvidia',
  deepseek: 'deepseek',
  openai: 'openai',
  mistral: 'mistral',
  minimax: 'minimax',
  microsoft: 'microsoft',
  anthropic: 'anthropic',
};

// Fallback: map model families to their publisher's brand by name (for entries without creator metadata).
const MODEL_BRAND: Array<{ match: RegExp; brand: string }> = [
  { match: /qwen|qwq/, brand: 'qwen' },
  { match: /gemma|gemini/, brand: 'gemini' },
  { match: /llama/, brand: 'meta' },
  { match: /nemotron|nemo/, brand: 'nvidia' },
  { match: /phi\b|phi-|phi4|phi3/, brand: 'microsoft' },
  { match: /mistral|mixtral/, brand: 'mistral' },
  { match: /deepseek/, brand: 'deepseek' },
  { match: /gpt-oss|whisper/, brand: 'openai' },
  { match: /minimax/, brand: 'minimax' },
];

// Custom hand-drawn mark by creator, for labs with no official /public/brands SVG (see the section above).
const CREATOR_GLYPH: Record<string, (props: IconProps) => ReactNode> = {
  'z ai': ZAiIcon,
  poolside: PoolsideIcon,
  'deep reinforce': DeepReinforceIcon,
  'liquid ai': LiquidAiIcon,
  cohere: CohereIcon,
  'thinking machines': ThinkingMachinesIcon,
};

/**
 * Icon for a catalog model: the publisher's official brand mark (resolved from the model's creator
 * metadata first, then a name regex), then a custom mark for labs with no sourced official logo,
 * falling back to a modality glyph (embedding / speech) and finally a generic cube.
 */
export function ModelIcon({ model, className }: { model: Pick<CuratedModel, 'id' | 'displayName' | 'modality' | 'metadata'>; className?: string }) {
  const creator = model.metadata?.creator?.toLowerCase();
  const key = `${model.displayName ?? ''} ${model.id ?? ''}`.toLowerCase();
  const brand = (creator ? CREATOR_BRAND[creator] : undefined) ?? MODEL_BRAND.find((b) => b.match.test(key))?.brand;
  if (brand) return <BrandLogo name={brand} className={className} />;
  const CustomMark = creator ? CREATOR_GLYPH[creator] : undefined;
  if (CustomMark) return <CustomMark className={className} />;
  if (model.modality === 'embedding') return <EmbeddingIcon className={className} />;
  if (model.modality === 'tts' || model.modality === 'stt') return <WaveIcon className={className} />;
  return <CubeIcon className={className} />;
}

/** Generic models / "Other models" drawer. */
export function CubeModelsIcon({ className }: IconProps) {
  return <CubeIcon className={className} />;
}

/* ── System overview ─────────────────────────────────────────────────────────────────────────── */

/** GPU — a graphics card with a fan. */
export function GpuIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="2.5" y="6" width="19" height="11" rx="1.5" />
      <circle cx="9" cy="11.5" r="3" />
      <path d="M16 9.5v4M18.5 9.5v4" />
      <path d="M5.5 17v2M19 17v2" />
    </Glyph>
  );
}

/** VRAM — a memory chip. */
export function VramIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <rect x="4" y="8.5" width="16" height="8" rx="1" />
      <path d="M7 8.5V5.5M12 8.5V5.5M17 8.5V5.5" />
      <path d="M7 16.5v2M12 16.5v2M17 16.5v2" />
      <path d="M8 12.5h8" />
    </Glyph>
  );
}
