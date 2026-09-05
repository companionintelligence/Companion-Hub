import type { AltEntry, AltsCategory } from '@/modules/onboarding/helpers/types';

const NON_TOKEN = /[^a-z0-9]+/g;

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function tokenizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query).split(NON_TOKEN).filter(Boolean);
}

/** True when `query` is empty or appears in `haystack` as a phrase or as tokens. */
export function textMatchesSearch(haystack: string, query: string): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  const hay = normalizeSearchText(haystack);
  if (!hay) return false;
  if (hay.includes(q)) return true;
  const queryTokens = tokenizeSearchQuery(q);
  if (queryTokens.length === 0) return true;
  const hayTokens = tokenizeSearchQuery(hay);
  return queryTokens.every((token) => hayTokens.some((hayToken) => hayToken.includes(token)) || hay.includes(token));
}

export function alternativeEntryMatchesSearch(entry: AltEntry, category: string, query: string): boolean {
  if (!normalizeSearchText(query)) return true;
  if (textMatchesSearch(category, query)) return true;
  const proprietaryHit = entry.proprietary.some((item) => textMatchesSearch(item.name, query));
  if (proprietaryHit) return true;
  return entry.alternatives.some((item) => textMatchesSearch(item.name, query) || (item.appSlug ? textMatchesSearch(item.appSlug, query) : false));
}

export function filterAlternativesBySearch(alts: AltsCategory, query: string): AltsCategory {
  if (!normalizeSearchText(query)) return alts;
  const result: AltsCategory = {};
  for (const [category, items] of Object.entries(alts)) {
    const filtered = items.filter((item) => alternativeEntryMatchesSearch(item, category, query));
    if (filtered.length > 0) {
      result[category] = filtered;
    }
  }
  return result;
}

/** Marketplace slugs whose alternative pairing matches the query (e.g. "google drive" → nextcloud). */
export function alternativeSlugsMatchingSearch(alts: AltsCategory, query: string): string[] {
  if (!normalizeSearchText(query)) return [];
  const slugs = new Set<string>();
  for (const [category, items] of Object.entries(alts)) {
    for (const item of items) {
      if (!alternativeEntryMatchesSearch(item, category, query)) continue;
      for (const alt of item.alternatives) {
        if (alt.appSlug) slugs.add(alt.appSlug);
      }
    }
  }
  return [...slugs];
}
