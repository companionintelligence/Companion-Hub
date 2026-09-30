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

// Artificial Analysis Intelligence Index, re-pulled 2026-09-29. The bands split THE CATALOG's own scores
// into five roughly equal groups, so the colors rank the models a user can actually install against each
// other — not against a leaderboard top (46.3, MiMo-V2.6-Pro) that no model this hardware runs comes near,
// which left the table 0 blue / 53 red. Over the 77 distinct scored catalog models (MTP twins counted once)
// the cuts give red 13, orange 21, gold 15, green 13, blue 15; orange is the widest because a crowd of older
// models sits at 6–7 and no cut can split equal displayed numbers. Each cut is at .5 so every whole number
// the table shows (it rounds) has exactly one color. The bar is full at the catalog's top (34.3 → 35).
// Re-derive both after a re-pull or a catalog change rather than keeping these numbers.
export const SCORE_BAR_MAX = 35;
export const scoreColor = (v: number): LevelColor => (v >= 13.5 ? 'blue' : v >= 9.5 ? 'green' : v >= 7.5 ? 'gold' : v >= 5.5 ? 'orange' : 'red');
// Resource size in GB: bigger is heavier → warmer (red).
export const resourceColor = (gb: number): LevelColor => (gb >= 48 ? 'red' : gb >= 16 ? 'orange' : gb >= 4 ? 'gold' : 'green');

/** Source of the intelligence benchmark score. */
export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/leaderboards/models?weights=open';
