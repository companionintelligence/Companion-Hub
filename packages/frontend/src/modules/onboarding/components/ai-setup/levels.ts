/**
 * Shared level-color scale (red → orange → gold → green → blue) used across the model-selection UI:
 * benchmark scores (higher = cooler/blue), tier tags, and resource sizes (bigger = warmer/red).
 */
export type LevelColor = 'red' | 'orange' | 'gold' | 'green' | 'blue';

/** Foreground text color per level (for numbers / values). */
export const LEVEL_TEXT: Record<LevelColor, string> = {
  red: 'text-red-400',
  orange: 'text-orange-400',
  gold: 'text-amber-400',
  green: 'text-emerald-400',
  blue: 'text-sky-400',
};

/** Solid fill per level (for score bars). */
export const LEVEL_BG: Record<LevelColor, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  gold: 'bg-amber-500',
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
};

/** Bordered tag (border + tinted bg + text) per level — for tier chips and group headers. */
export const LEVEL_TAG: Record<LevelColor, string> = {
  red: 'border-red-500/30 bg-red-500/15 text-red-300',
  orange: 'border-orange-500/30 bg-orange-500/15 text-orange-300',
  gold: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  green: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  blue: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
};

// Tier tag color: a heavier hardware requirement is warmer (green = runs anywhere → red = high-end only).
export const TIER_TAG_COLOR: Record<string, LevelColor> = { 'cpu-only': 'green', low: 'gold', medium: 'orange', high: 'red' };
export const TIER_TAG_LABEL: Record<string, string> = { 'cpu-only': 'cpu', low: 'low', medium: 'medium', high: 'high', insufficient: 'n/a' };

// Benchmark score (0–~65): higher is better → cooler (blue).
export const scoreColor = (v: number): LevelColor => (v >= 50 ? 'blue' : v >= 38 ? 'green' : v >= 26 ? 'gold' : v >= 14 ? 'orange' : 'red');
// Resource size in GB: bigger is heavier → warmer (red).
export const resourceColor = (gb: number): LevelColor => (gb >= 48 ? 'red' : gb >= 16 ? 'orange' : gb >= 4 ? 'gold' : 'green');

/** Source of the intelligence / tool-use benchmark scores. */
export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/leaderboards/models?weights=open';
