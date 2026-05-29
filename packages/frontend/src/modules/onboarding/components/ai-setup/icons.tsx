import type { CuratedModel } from '@ci-hub/common/types';
import type { ReactNode } from 'react';

/**
 * Cohesive line-style iconography for the AI setup wizard. Every icon strokes with `currentColor`
 * (fill: none) so it inherits the surrounding text color — set `text-primary` for the cyan accent.
 * Style: stroke-width 1.75, round caps/joins, 24×24 viewBox. Size via `className` (e.g. `h-10 w-10`).
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

/* ----------------------------------------------------------------------------------------------- */
/* Agent frameworks                                                                                 */
/* ----------------------------------------------------------------------------------------------- */

/** OpenClaw — a crab. */
export function OpenClawIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M5.5 14.5c0-3 2.9-5 6.5-5s6.5 2 6.5 5v.5a3 3 0 0 1-3 3H8.5a3 3 0 0 1-3-3v-.5Z" />
      <circle cx="9.8" cy="13.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="13.6" r="0.7" fill="currentColor" stroke="none" />
      <path d="M9.4 9.7 8.4 7.2M14.6 9.7l1-2.5" />
      <path d="M6.4 13.3 4 11.6a2 2 0 0 1 .3-3.6M4.6 9.5l2 .6" />
      <path d="M17.6 13.3 20 11.6a2 2 0 0 0-.3-3.6M19.4 9.5l-2 .6" />
      <path d="M8 18.2l-1.7 1.9M10.6 19.1l-.8 2.2M13.4 19.1l.8 2.2M16 18.2l1.7 1.9" />
    </Glyph>
  );
}

/** Hermes — a winged helmet. */
export function HermesIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M6.5 13a5.5 5.5 0 0 1 11 0v.5h-11V13Z" />
      <path d="M6.5 13.5h11l-1.3 3.2a1 1 0 0 1-.9.6H8.7a1 1 0 0 1-.9-.6L6.5 13.5Z" />
      <path d="M17 8.6c1.8-1.2 3.7-1.4 5.2-.6-1.2 1.4-3 2-5 2" />
      <path d="M17.4 11c1.3-.6 2.7-.7 3.9-.2" />
      <path d="M11.5 17.4 11 20.5" />
    </Glyph>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Inference backends                                                                               */
/* ----------------------------------------------------------------------------------------------- */

/** Ollama — a llama head. */
export function OllamaIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M8.5 20.5v-6.2c0-2.1 1.5-3.8 3.5-3.8s3.5 1.7 3.5 3.8v6.2" />
      <path d="M9.2 10.7 8 6.4c1.2.2 2.2 1 2.7 2.1M14.8 10.7 16 6.4c-1.2.2-2.2 1-2.7 2.1" />
      <circle cx="10.6" cy="14" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="14" r="0.65" fill="currentColor" stroke="none" />
      <path d="M11 16.8h2" />
    </Glyph>
  );
}

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

/* ----------------------------------------------------------------------------------------------- */
/* Models                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

/** Qwen — hex badge with a Q. */
function QwenIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3l7.4 4.3v8.6L12 20.2l-7.4-4.3V7.3L12 3Z" />
      <circle cx="11.6" cy="11.6" r="3.1" />
      <path d="M13.4 13.4 16 16" />
    </Glyph>
  );
}

/** Isometric cube — generic model fallback (and Nemotron). */
function CubeIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3.2l8 4.2v8.6l-8 4.2-8-4.2V7.4l8-4.2Z" />
      <path d="M4.3 7.6 12 11.6l7.7-4M12 11.6v8.6" />
    </Glyph>
  );
}

/** Gemma — a four-point sparkle. */
function SparkIcon({ className }: IconProps) {
  return (
    <Glyph className={className}>
      <path d="M12 3c.6 4.6 1.4 5.4 6 6-4.6.6-5.4 1.4-6 6-.6-4.6-1.4-5.4-6-6 4.6-.6 5.4-1.4 6-6Z" />
    </Glyph>
  );
}

/** Best-effort icon for a catalog model, matched by family name with a cube fallback. */
export function ModelIcon({ model, className }: { model: Pick<CuratedModel, 'id' | 'displayName'>; className?: string }) {
  const key = `${model.displayName ?? ''} ${model.id ?? ''}`.toLowerCase();
  if (key.includes('qwen')) return <QwenIcon className={className} />;
  if (key.includes('gemma')) return <SparkIcon className={className} />;
  if (key.includes('llama')) return <OllamaIcon className={className} />;
  if (key.includes('nemotron') || key.includes('nemo')) return <CubeIcon className={className} />;
  return <CubeIcon className={className} />;
}

/** Generic models / "Other models" drawer. */
export function CubeModelsIcon({ className }: IconProps) {
  return <CubeIcon className={className} />;
}

/* ----------------------------------------------------------------------------------------------- */
/* System overview                                                                                  */
/* ----------------------------------------------------------------------------------------------- */

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
