import type { AltsCategory, AltEntry, AltAlternative } from './types';
import altsData from '@/lib/data/alts.json';

export type { AltsCategory, AltEntry, AltAlternative };

/**
 * Get all alternatives data flattened with category info
 */
export function getAllAlternatives(): Array<AltEntry & { category: string }> {
  const result: Array<AltEntry & { category: string }> = [];
  for (const [category, entries] of Object.entries(altsData as Record<string, AltEntry[]>)) {
    for (const entry of entries) {
      result.push({ ...entry, category });
    }
  }
  return result;
}

/**
 * Get recommended apps based on detected services.
 * Returns alternatives for services that are NOT already running.
 */
export function getRecommendedApps(
  detectedServiceNames: string[],
): Array<{ category: string; proprietary: string[]; alternatives: AltAlternative[] }> {
  const allAlts = getAllAlternatives();
  const detectedLower = new Set(detectedServiceNames.map((n) => n.toLowerCase()));

  // For each alt group, check if any detected service matches a proprietary name
  // Also filter out alternatives that are already running
  const recommendations: Array<{ category: string; proprietary: string[]; alternatives: AltAlternative[] }> = [];

  for (const entry of allAlts) {
    const filteredAlts = entry.alternatives.filter((alt) => {
      const slug = alt.appSlug?.toLowerCase() ?? '';
      return !detectedLower.has(slug) && !detectedLower.has(alt.name.toLowerCase());
    });

    if (filteredAlts.length > 0) {
      recommendations.push({
        category: entry.category,
        proprietary: entry.proprietary.map((p) => p.name),
        alternatives: filteredAlts,
      });
    }
  }

  return recommendations;
}
