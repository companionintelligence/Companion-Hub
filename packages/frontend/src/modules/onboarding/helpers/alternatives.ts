import { findCatalogAppBySlug } from '@/lib/marketplace-app-slug';
import { ONBOARDING_CURATED_PICKS, type OnboardingCuratedPick } from './onboarding-curated-picks';
import type { AltsCategory, AltAlternative, AltEntry } from './types';

export type { AltsCategory, AltEntry, AltAlternative };

export type OnboardingRecommendation = {
  category: string;
  proprietary: string[];
  alternatives: AltAlternative[];
  /** True when a detected Docker service matched this pick's proprietary target. */
  boosted: boolean;
};

type CatalogApp = { id?: string | null; urn?: string | null; name?: string; icon?: string | null; short_desc?: string };

/**
 * Get all alternatives data flattened with category info
 */
export function getAllAlternatives(altsData: AltsCategory): Array<AltEntry & { category: string }> {
  const result: Array<AltEntry & { category: string }> = [];
  for (const [category, entries] of Object.entries(altsData)) {
    for (const entry of entries) {
      result.push({ ...entry, category });
    }
  }
  return result;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function isAlreadyRunning(slug: string, altName: string, detectedLower: Set<string>): boolean {
  return detectedLower.has(slug.toLowerCase()) || detectedLower.has(altName.toLowerCase());
}

function findAltEntryForSlug(altsData: AltsCategory, slug: string): { category: string; entry: AltEntry; alt: AltAlternative } | null {
  for (const [category, entries] of Object.entries(altsData)) {
    for (const entry of entries) {
      const alt = entry.alternatives.find((a) => a.appSlug === slug);
      if (alt) {
        return { category, entry, alt };
      }
    }
  }
  return null;
}

function proprietaryNamesForPick(pick: OnboardingCuratedPick, altsData: AltsCategory, resolvedSlug: string): string[] {
  const fromAlt = findAltEntryForSlug(altsData, resolvedSlug);
  if (fromAlt) {
    return fromAlt.entry.proprietary.map((p) => p.name);
  }
  return [pick.proprietaryLabel];
}

function detectedMatchesPick(detectedLower: Set<string>, pick: OnboardingCuratedPick, altsData: AltsCategory): boolean {
  const labels = new Set<string>([normalizeName(pick.proprietaryLabel)]);

  for (const [category, entries] of Object.entries(altsData)) {
    if (category !== pick.category) continue;
    for (const entry of entries) {
      for (const p of entry.proprietary) {
        if (normalizeName(p.name) === normalizeName(pick.proprietaryLabel)) {
          labels.add(normalizeName(p.name));
          for (const alt of entry.alternatives) {
            if (pick.preferredSlugs.includes(alt.appSlug ?? '')) {
              labels.add(normalizeName(p.name));
            }
          }
        }
      }
    }
  }

  for (const detected of detectedLower) {
    for (const label of labels) {
      if (detected.includes(label) || label.includes(detected)) {
        return true;
      }
    }
  }

  return false;
}

function resolvePickSlugs(pick: OnboardingCuratedPick, storeApps: CatalogApp[]): string[] {
  return pick.preferredSlugs.filter((slug) => !!findCatalogAppBySlug(storeApps, slug));
}

/**
 * Resolve curated onboarding recommendations: preferred marketplace apps per
 * category (in preferred-slug order), filtered for already-running services.
 * Multiple preferred slugs in the catalog become separate picks so onboarding
 * can reveal more recommendations over time.
 */
export function resolveOnboardingRecommendations(
  detectedServiceNames: string[],
  altsData: AltsCategory,
  storeApps: CatalogApp[],
): OnboardingRecommendation[] {
  const detectedLower = new Set(detectedServiceNames.map(normalizeName));
  const resolved: OnboardingRecommendation[] = [];

  for (const pick of ONBOARDING_CURATED_PICKS) {
    const boosted = detectedMatchesPick(detectedLower, pick, altsData);

    for (const slug of resolvePickSlugs(pick, storeApps)) {
      const storeApp = findCatalogAppBySlug(storeApps, slug);
      const altMeta = findAltEntryForSlug(altsData, slug);
      const altName = altMeta?.alt.name ?? storeApp?.name ?? slug;

      if (isAlreadyRunning(slug, altName, detectedLower)) continue;

      const alt: AltAlternative = altMeta?.alt ?? {
        name: altName,
        icon: storeApp?.icon ?? '',
        url: '',
        appSlug: slug,
      };

      resolved.push({
        category: pick.category,
        proprietary: proprietaryNamesForPick(pick, altsData, slug),
        alternatives: [alt],
        boosted,
      });
    }
  }

  resolved.sort((a, b) => {
    if (a.boosted !== b.boosted) return a.boosted ? -1 : 1;
    const aIndex = ONBOARDING_CURATED_PICKS.findIndex((p) => p.category === a.category);
    const bIndex = ONBOARDING_CURATED_PICKS.findIndex((p) => p.category === b.category);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return (a.alternatives[0]?.appSlug ?? '').localeCompare(b.alternatives[0]?.appSlug ?? '');
  });

  return resolved;
}

/**
 * @deprecated Use resolveOnboardingRecommendations for onboarding step 4.
 * Returns all alternative groups (legacy full dump).
 */
export function getRecommendedApps(
  detectedServiceNames: string[],
  altsData: AltsCategory,
): Array<{ category: string; proprietary: string[]; alternatives: AltAlternative[] }> {
  const allAlts = getAllAlternatives(altsData);
  const detectedLower = new Set(detectedServiceNames.map((n) => n.toLowerCase()));

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
