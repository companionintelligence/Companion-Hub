const NON_TOKEN = /[^a-z0-9]+/g;

export type StoreSearchProprietary = { name?: unknown };
export type StoreSearchAlternative = { name?: unknown; appSlug?: unknown };
export type StoreSearchEntry = {
  proprietary?: StoreSearchProprietary[];
  alternatives?: StoreSearchAlternative[];
};
export type StoreSearchCatalog = Record<string, StoreSearchEntry[]>;

export function parseReplaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      names.push(item.trim());
    }
  }
  return names;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function tokenizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query).split(NON_TOKEN).filter(Boolean);
}

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

function readName(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readSlug(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseAlternativesCatalog(raw: unknown): StoreSearchCatalog {
  if (raw === null || typeof raw !== 'object') return {};
  const out: StoreSearchCatalog = {};
  for (const [category, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list: StoreSearchEntry[] = [];
    for (const row of entries) {
      if (!row || typeof row !== 'object') continue;
      const proprietaryRaw = (row as StoreSearchEntry).proprietary;
      const alternativesRaw = (row as StoreSearchEntry).alternatives;
      if (!Array.isArray(proprietaryRaw) || !Array.isArray(alternativesRaw)) continue;
      const proprietary = proprietaryRaw.filter((item) => typeof item?.name === 'string');
      const alternatives = alternativesRaw.filter((item) => typeof item?.name === 'string');
      if (proprietary.length > 0 && alternatives.length > 0) {
        list.push({ proprietary, alternatives });
      }
    }
    if (list.length > 0) out[category] = list;
  }
  return out;
}

export function alternativeEntryMatchesSearch(entry: StoreSearchEntry, category: string, query: string): boolean {
  if (!normalizeSearchText(query)) return true;
  if (textMatchesSearch(category, query)) return true;
  if ((entry.proprietary ?? []).some((item) => textMatchesSearch(readName(item.name), query))) return true;
  return (entry.alternatives ?? []).some((item) => {
    const name = readName(item.name);
    const slug = readSlug(item.appSlug);
    return textMatchesSearch(name, query) || (slug ? textMatchesSearch(slug, query) : false);
  });
}

export function alternativeSlugsMatchingSearch(alts: StoreSearchCatalog, query: string): string[] {
  if (!normalizeSearchText(query)) return [];
  const slugs = new Set<string>();
  for (const [category, items] of Object.entries(alts)) {
    for (const item of items) {
      if (!alternativeEntryMatchesSearch(item, category, query)) continue;
      for (const alt of item.alternatives ?? []) {
        const slug = readSlug(alt.appSlug);
        if (slug) slugs.add(slug);
      }
    }
  }
  return [...slugs];
}

/** Joined proprietary + sibling names used as MiniSearch aliases for a slug. */
export function searchAliasTextByAppId(alts: StoreSearchCatalog): Map<string, string> {
  const map = new Map<string, Set<string>>();
  for (const [category, items] of Object.entries(alts)) {
    for (const item of items) {
      const terms = [category, ...(item.proprietary ?? []).map((p) => readName(p.name)), ...(item.alternatives ?? []).map((a) => readName(a.name))];
      for (const alt of item.alternatives ?? []) {
        const slug = readSlug(alt.appSlug);
        if (!slug) continue;
        const bucket = map.get(slug) ?? new Set<string>();
        for (const term of terms) {
          if (term) bucket.add(term);
        }
        map.set(slug, bucket);
      }
    }
  }
  return new Map([...map.entries()].map(([slug, terms]) => [slug, [...terms].join(' ')]));
}
