/** Resolve marketplace app slug from search/catalog entries (portal may omit id). */
export function catalogAppSlug(app: { id?: string | null; urn?: string | null }): string | undefined {
  const id = app.id?.trim();
  if (id) return id;

  const urn = app.urn?.trim();
  if (!urn) return undefined;

  const slug = urn.split(':')[0]?.trim();
  return slug || undefined;
}

export function findCatalogAppBySlug<T extends { id?: string | null; urn?: string | null }>(apps: T[], slug: string): T | undefined {
  return apps.find((app) => catalogAppSlug(app) === slug);
}
