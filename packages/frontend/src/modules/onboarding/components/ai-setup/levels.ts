/**
 * Shared level-color scale (red → orange → gold → green → blue) used across the model-selection UI:
 * benchmark scores (higher = cooler/blue), tier tags, and resource sizes (bigger = warmer/red).
 *
 * Sourced from @companionintelligence/tokens' `--level-*` scale (styles/colors.md § Level
 * scale in CI-Common) rather than raw Tailwind palette classes — this file is literally what
 * that token group was modeled on, so the hex values are unchanged, just named now.
 */
export type LevelColor = 'red' | 'orange' | 'gold' | 'green' | 'blue';

/** Foreground text color per level (for numbers / values). */
export const LEVEL_TEXT: Record<LevelColor, string> = {
  red: 'text-level-red',
  orange: 'text-level-orange',
  gold: 'text-level-gold',
  green: 'text-level-green',
  blue: 'text-level-blue',
};

/** Solid fill per level (for score bars). */
export const LEVEL_BG: Record<LevelColor, string> = {
  red: 'bg-level-red',
  orange: 'bg-level-orange',
  gold: 'bg-level-gold',
  green: 'bg-level-green',
  blue: 'bg-level-blue',
};

/** Bordered tag (border + tinted bg + text) per level — for tier chips and group headers. */
export const LEVEL_TAG: Record<LevelColor, string> = {
  red: 'border-level-red/30 bg-level-red/15 text-level-red',
  orange: 'border-level-orange/30 bg-level-orange/15 text-level-orange',
  gold: 'border-level-gold/30 bg-level-gold/15 text-level-gold',
  green: 'border-level-green/30 bg-level-green/15 text-level-green',
  blue: 'border-level-blue/30 bg-level-blue/15 text-level-blue',
};

// Tier tag color: a heavier hardware requirement is warmer (green = runs anywhere → red = high-end only).
export const TIER_TAG_COLOR: Record<string, LevelColor> = { 'cpu-only': 'green', low: 'gold', medium: 'orange', high: 'red' };
export const TIER_TAG_LABEL: Record<string, string> = { 'cpu-only': 'cpu', low: 'low', medium: 'medium', high: 'high', insufficient: 'n/a' };

// Artificial Analysis Intelligence Index v4.3 (re-pulled 2026-09-16): the best open-weight model scores
// ~34 and the frontier ~53, about half the pre-v4.3 scale these bands were first tuned for (blue ≥ 50,
// green ≥ 38, gold ≥ 26, orange ≥ 14). Bands follow the scale; if the catalog is re-pulled onto a new index
// version, re-derive them from the distribution rather than keeping these numbers.
export const SCORE_BAR_MAX = 40;
export const scoreColor = (v: number): LevelColor => (v >= 30 ? 'blue' : v >= 20 ? 'green' : v >= 12 ? 'gold' : v >= 7 ? 'orange' : 'red');
// Resource size in GB: bigger is heavier → warmer (red).
export const resourceColor = (gb: number): LevelColor => (gb >= 48 ? 'red' : gb >= 16 ? 'orange' : gb >= 4 ? 'gold' : 'green');

/** Source of the intelligence benchmark score. */
export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/leaderboards/models?weights=open';
