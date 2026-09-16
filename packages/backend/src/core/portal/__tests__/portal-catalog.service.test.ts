import { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalCatalogService } from '../portal-catalog.service';
import { PORTAL_STORE_LISTING_TIMEOUT_MS } from '../portal.constants';
import { PortalClientService } from '../portal-client.service';

describe('PortalCatalogService', () => {
  let service: PortalCatalogService;
  let portalClient: MockProxy<PortalClientService>;
  let logger: MockProxy<LoggerService>;

  beforeEach(() => {
    portalClient = mock<PortalClientService>();
    logger = mock<LoggerService>();
    portalClient.getPublicPortalUrl.mockReturnValue('https://portal.example.com');
    portalClient.fetchStoreMetadataText.mockResolvedValue(null);
    service = new PortalCatalogService(portalClient, logger);
  });

  it('maps portal store apps with id matching slug for onboarding lookups', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'ci-memory',
        name: 'CI Memory',
        short_desc: 'Private memory server',
        categories: ['ai'],
        icon: 'https://cdn.example.com/ci-memory.png',
      },
      {
        id: 'ci-planning',
        name: 'Companion Planning',
        shortDescription: 'Local planning',
      },
    ] as any);

    const entries = await service.getCatalogEntries(true);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'ci-memory',
      urn: 'ci-memory:ci-marketplace',
      name: 'CI Memory',
      icon: 'https://cdn.example.com/ci-memory.png',
    });
    expect(entries[1]).toMatchObject({
      id: 'ci-planning',
      urn: 'ci-planning:ci-marketplace',
    });
  });

  it('searchCatalog matches proprietary platforms from the app replaces field', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'nextcloud',
        name: 'Nextcloud',
        short_desc: 'A safe home for all your data.',
        categories: ['data'],
        replaces: ['Google Drive', 'Dropbox'],
      },
      { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] },
    ] as any);
    portalClient.fetchStoreAlternatives.mockResolvedValue({});

    const result = await service.searchCatalog({ search: 'google drive', pageSize: 50 });

    expect(result?.data.map((entry) => entry.id)).toEqual(['nextcloud']);
    expect(result?.data[0]?.replaces).toEqual(['Google Drive', 'Dropbox']);
  });

  it('searchCatalog returns Nextcloud when the query is a proprietary alternative', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] },
      { slug: 'nextcloud', name: 'Nextcloud', short_desc: 'Self-hosted files', categories: ['data'] },
    ] as any);
    portalClient.fetchStoreAlternatives.mockResolvedValue({
      data: [
        {
          proprietary: [{ name: 'Google Drive' }, { name: 'Dropbox' }],
          alternatives: [{ name: 'Nextcloud', appSlug: 'nextcloud' }],
        },
      ],
    });

    const result = await service.searchCatalog({ search: 'google drive', pageSize: 50 });

    expect(result?.data.map((entry) => entry.id)).toEqual(['nextcloud']);
  });

  it('searchCatalog returns entries with id', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([{ slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] }] as any);

    const result = await service.searchCatalog({ pageSize: 50 });

    expect(result?.data).toHaveLength(1);
    expect(result?.data[0]?.id).toBe('ghost');
    expect(result?.data[0]?.urn).toBe('ghost:ci-marketplace');
  });

  it('filters Hub-managed Cloudflare Tunnel entries from the installable catalog', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      { slug: 'cloudflared', name: 'Cloudflare Tunnel', short_desc: 'Hub-managed tunnel', categories: ['networking'] },
      { slug: 'cloudflare-tunnel', name: 'Cloudflare Tunnel', short_desc: 'Legacy tunnel listing', categories: ['networking'] },
      { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] },
    ] as any);

    const result = await service.searchCatalog({ pageSize: 50 });

    expect(result?.data.map((entry) => entry.urn)).toEqual(['ghost:ci-marketplace']);
  });

  it('does not resolve Hub-managed Cloudflare Tunnel entries as installable app details', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      { slug: 'cloudflared', name: 'Cloudflare Tunnel', short_desc: 'Hub-managed tunnel', categories: ['networking'] },
    ] as any);

    await expect(service.getAppInfoForUrn('cloudflared:ci-marketplace' as any)).resolves.toBeNull();
    expect(portalClient.fetchStoreCatalog).not.toHaveBeenCalled();
  });

  it('resolves icon URLs by marketplace urn slug', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'], icon: 'https://cdn.example.com/ghost.png' },
    ] as any);

    await service.getCatalogEntries(true);

    await expect(service.getIconUrlForUrn('ghost:ci-marketplace' as any)).resolves.toBe('https://cdn.example.com/ghost.png');
  });

  it('maps portal catalog entries to full app info for store detail pages', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'ghost',
        name: 'Ghost',
        author: 'Ghost Foundation',
        short_desc: 'Blog platform',
        description: 'Publish with Ghost.',
        categories: ['social'],
        port: 2368,
        version: '5.0.0',
        source: 'https://ghost.org',
      },
    ] as any);
    portalClient.fetchStoreMetadataText.mockResolvedValue('# Ghost\n\nMarkdown description.');

    await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({
      id: 'ghost',
      urn: 'ghost:ci-marketplace',
      name: 'Ghost',
      author: 'Ghost Foundation',
      short_desc: 'Blog platform',
      description: '# Ghost\n\nMarkdown description.',
      port: 2368,
    });
    expect(portalClient.fetchStoreMetadataText).toHaveBeenCalledWith('ghost', 'description.md');
  });

  it('preserves form_fields from portal catalog metadata for install dialogs', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'n8n',
        name: 'n8n',
        short_desc: 'Workflow automation',
        categories: ['automation'],
        form_fields: [
          { type: 'password', label: 'DB password', env_variable: 'N8N_DB_PASSWORD', required: false },
          { type: 'text', label: 'Username', env_variable: 'APP_USER', required: true },
        ],
      },
    ] as any);

    await expect(service.getAppInfoForUrn('n8n:ci-marketplace' as any)).resolves.toMatchObject({
      form_fields: [
        { type: 'password', label: 'DB password', env_variable: 'N8N_DB_PASSWORD', required: false },
        { type: 'text', label: 'Username', env_variable: 'APP_USER', required: true },
      ],
    });
  });

  it('preserves screenshots and demo_video from portal catalog metadata', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'ci-memory',
        name: 'Companion Memory',
        short_desc: 'Memory appliance',
        categories: ['ai'],
        screenshots: ['https://github.com/user-attachments/assets/abc123'],
        demo_video: './metadata/media/demo.mp4',
      },
    ] as any);

    await expect(service.getAppInfoForUrn('ci-memory:ci-marketplace' as any)).resolves.toMatchObject({
      screenshots: ['https://github.com/user-attachments/assets/abc123'],
      demo_video: './metadata/media/demo.mp4',
    });
  });

  it('preserves MCP listing metadata and keeps MCP apps non-exposable without a fake port', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'filesystem-mcp',
        name: 'Filesystem MCP',
        short_desc: 'Filesystem tools',
        categories: ['mcp'],
        no_gui: true,
        exposable: false,
        form_fields: [{ type: 'text', label: 'Root', env_variable: 'ALLOWED_PATH', required: true, default: '/data' }],
        mcp: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    ] as any);

    await expect(service.getAppInfoForUrn('filesystem-mcp:ci-marketplace' as any)).resolves.toMatchObject({
      no_gui: true,
      exposable: false,
      mcp: { transport: 'stdio', command: 'npx' },
      form_fields: [{ env_variable: 'ALLOWED_PATH', default: '/data' }],
    });
  });

  it('returns update info from the warmed portal catalog cache', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([
      {
        slug: 'ci-memory',
        name: 'CI Memory',
        short_desc: 'Private memory server',
        categories: ['ai'],
        version: '2026.7.17.1',
        cihub_app_version: 42,
      },
    ] as any);

    await service.getCatalogEntries(true);

    expect(service.getUpdateInfoForUrn('ci-memory:ci-marketplace' as any)).toEqual({
      latestVersion: 42,
      latestDockerVersion: '2026.7.17.1',
      minHubVersion: null,
    });
  });

  it('returns null update info on a cold cache without blocking on the network', () => {
    let resolveFetch: (value: unknown) => void = () => {};
    portalClient.fetchStoreCatalog.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    // Must return synchronously (null) while the background warm is still pending.
    expect(service.getUpdateInfoForUrn('ci-memory:ci-marketplace' as any)).toBeNull();
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);

    resolveFetch([]);
  });

  it('dedupes concurrent catalog fetches into a single portal request', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    portalClient.fetchStoreCatalog.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    const first = service.getCatalogEntries(true);
    const second = service.getCatalogEntries(true);
    resolveFetch([{ slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] }]);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not keep a stale inflight catalog after invalidateCache', async () => {
    let resolveStale: (value: unknown) => void = () => {};
    portalClient.fetchStoreCatalog.mockReturnValueOnce(new Promise((resolve) => (resolveStale = resolve)));

    const stalePromise = service.getCatalogEntries(true);
    service.invalidateCache();

    portalClient.fetchStoreCatalog.mockResolvedValueOnce([
      { slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.23', categories: ['ai'] },
    ] as any);

    const freshPromise = service.getCatalogEntries(true);
    resolveStale([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.18', categories: ['ai'] }]);

    await stalePromise;
    const fresh = await freshPromise;
    expect(fresh[0]?.version).toBe('2026.8.23');

    const cached = await service.getCatalogEntries(false);
    expect(cached[0]?.version).toBe('2026.8.23');
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: true }));
  });

  it('fetches the store listing with the extended catalog timeout', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([]);

    await service.getCatalogEntries(true);

    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledWith({ bypassCache: true, timeoutMs: PORTAL_STORE_LISTING_TIMEOUT_MS });
    expect(PORTAL_STORE_LISTING_TIMEOUT_MS).toBeGreaterThan(37_000);
  });

  it('answers from a catalog past its TTL at once and refreshes it in the background', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      portalClient.fetchStoreCatalog.mockResolvedValueOnce([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.18' }] as any);
      await service.getCatalogEntries(true);

      now.mockReturnValue(1_000_000 + 16 * 60_000);
      let resolveRefresh: (value: unknown) => void = () => {};
      portalClient.fetchStoreCatalog.mockReturnValueOnce(new Promise((resolve) => (resolveRefresh = resolve)));

      // Resolves with the catalog in hand even though the refresh has not answered.
      const stale = await service.getCatalogEntries(false);
      expect(stale[0]?.version).toBe('2026.8.18');
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

      // A second caller joins the running refresh rather than starting another.
      await service.getCatalogEntries(false);
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

      resolveRefresh([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.23' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const fresh = await service.getCatalogEntries(false);
      expect(fresh[0]?.version).toBe('2026.8.23');
    } finally {
      now.mockRestore();
    }
  });

  it('hasCatalog reports a held catalog, including one kept after a failed refresh', async () => {
    expect(service.hasCatalog()).toBe(false);

    portalClient.fetchStoreCatalog.mockResolvedValueOnce([{ slug: 'ghost', name: 'Ghost' }] as any);
    await service.getCatalogEntries(true);
    expect(service.hasCatalog()).toBe(true);

    portalClient.fetchStoreCatalog.mockRejectedValueOnce(new Error('timeout of 45000ms exceeded'));
    await service.getCatalogEntries(true);
    expect(service.hasCatalog()).toBe(true);

    service.invalidateCache();
    expect(service.hasCatalog()).toBe(false);
  });

  it('mapCatalogRows applies the live catalog filters to rows from any source', () => {
    const entries = service.mapCatalogRows([
      { slug: 'ci-memory', name: 'Companion Memory', categories: ['ai'] },
      { slug: 'cloudflared', name: 'Cloudflare Tunnel' },
      { slug: 'old-app', name: 'Old', deprecated: true },
      { slug: 'withdrawn', name: 'Withdrawn', available: false },
      { name: 'No identity' },
      null,
      'not-a-row',
    ]);

    expect(entries.map((entry) => entry.urn)).toEqual(['ci-memory:ci-marketplace']);
  });

  it('searchCatalogEntries searches a catalog in hand without waiting on Portal alternatives', () => {
    portalClient.fetchStoreAlternatives.mockReturnValue(new Promise(() => {}));
    const entries = service.mapCatalogRows([
      { slug: 'nextcloud', name: 'Nextcloud', categories: ['data'], replaces: ['Google Drive'] },
      { slug: 'ghost', name: 'Ghost', categories: ['social'] },
    ]);

    const result = service.searchCatalogEntries(entries, { search: 'google drive', pageSize: 50 });

    expect(result.data.map((entry) => entry.id)).toEqual(['nextcloud']);
    // The cold alternatives cache is warmed for the next search, not awaited for this one.
    expect(portalClient.fetchStoreAlternatives).toHaveBeenCalledTimes(1);
    expect(service.searchCatalogEntries(entries, { category: 'social' }).data.map((entry) => entry.id)).toEqual(['ghost']);
  });

  it('resumes paging after a cursor this catalog lacks instead of repeating the first page', () => {
    const entries = service.mapCatalogRows([
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'charlie', name: 'Charlie' },
      { slug: 'echo', name: 'Echo' },
    ]);

    // e.g. a cursor from the synced snapshot naming an app Portal's catalog no longer lists.
    const next = service.searchCatalogEntries(entries, { cursor: 'bravo:ci-marketplace', pageSize: 1 });
    expect(next.data.map((entry) => entry.id)).toEqual(['charlie']);
    expect(next.nextCursor).toBe('echo:ci-marketplace');

    expect(service.searchCatalogEntries(entries, { cursor: 'zulu:ci-marketplace', pageSize: 1 })).toEqual({ data: [], total: 3, nextCursor: null });
    // A cursor the catalog holds still starts its own page.
    expect(service.searchCatalogEntries(entries, { cursor: 'charlie:ci-marketplace', pageSize: 5 }).data.map((entry) => entry.id)).toEqual([
      'charlie',
      'echo',
    ]);
  });

  it('force-refreshes even when a warm cache already exists', async () => {
    portalClient.fetchStoreCatalog
      .mockResolvedValueOnce([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.18', categories: ['ai'] }] as any)
      .mockResolvedValueOnce([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.23', categories: ['ai'] }] as any);

    const first = await service.getCatalogEntries(true);
    expect(first[0]?.version).toBe('2026.8.18');

    const second = await service.getCatalogEntries(true);
    expect(second[0]?.version).toBe('2026.8.23');
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
  });

  it('does not join a non-bypassing inflight fetch when force-refreshing', async () => {
    let resolveStale: (value: unknown) => void = () => {};
    portalClient.fetchStoreCatalog.mockReturnValueOnce(new Promise((resolve) => (resolveStale = resolve)));

    const stalePromise = service.getCatalogEntries(false);
    portalClient.fetchStoreCatalog.mockResolvedValueOnce([
      { slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.23', categories: ['ai'] },
    ] as any);

    const freshPromise = service.getCatalogEntries(true);
    resolveStale([{ slug: 'ci-memory', name: 'Companion Memory', version: '2026.8.18', categories: ['ai'] }]);

    const [stale, fresh] = await Promise.all([stalePromise, freshPromise]);
    expect(fresh[0]?.version).toBe('2026.8.23');
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    expect(portalClient.fetchStoreCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ bypassCache: true }));

    const cached = await service.getCatalogEntries(false);
    expect(cached[0]?.version).toBe('2026.8.23');
    // The stale caller may still resolve to the catalog it requested; it must
    // not republish over the force-refresh cache.
    expect(['2026.8.18', '2026.8.23']).toContain(stale[0]?.version);
  });
  describe('per-app metadata lookups', () => {
    const catalog = (...slugs: string[]) =>
      slugs.map((slug) => ({ slug, name: slug, short_desc: `${slug} app`, categories: ['ai'], port: 8080, version: '1.0.0' }));

    it('answers lookups for different apps from one catalog fetch', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost', 'n8n', 'ci-memory', 'immich', 'jellyfin') as any);

      for (const slug of ['ghost', 'n8n', 'ci-memory', 'immich', 'jellyfin']) {
        await expect(service.getAppInfoForUrn(`${slug}:ci-marketplace` as any)).resolves.toMatchObject({ id: slug });
      }

      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);
    });

    it('does not fetch again when the catalog is already warm', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost') as any);

      await service.getCatalogEntries(true);
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);
    });

    it('uses the extended catalog timeout instead of the default client timeout', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost') as any);

      await service.getAppInfoForUrn('ghost:ci-marketplace' as any);

      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: PORTAL_STORE_LISTING_TIMEOUT_MS }));
    });

    it('dedupes concurrent lookups into a single catalog fetch', async () => {
      let resolveFetch: (value: unknown) => void = () => {};
      portalClient.fetchStoreCatalog.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

      const lookups = Promise.all([
        service.getAppInfoForUrn('ghost:ci-marketplace' as any),
        service.getAppInfoForUrn('n8n:ci-marketplace' as any),
        service.getAppInfoForUrn('ci-memory:ci-marketplace' as any),
      ]);
      resolveFetch(catalog('ghost', 'n8n', 'ci-memory'));

      expect((await lookups).map((info) => info?.id)).toEqual(['ghost', 'n8n', 'ci-memory']);
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);
    });

    it('refreshes once for a slug the cached catalog lacks and resolves a just-published app', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
      await service.getCatalogEntries(true);

      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost', 'brand-new') as any);

      await expect(service.getAppInfoForUrn('brand-new:ci-marketplace' as any)).resolves.toMatchObject({ id: 'brand-new' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
      expect(portalClient.fetchStoreCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ bypassCache: true }));
      // The refreshed catalog is published, so the next lookup for it is a cache read.
      await expect(service.getAppInfoForUrn('brand-new:ci-marketplace' as any)).resolves.toMatchObject({ id: 'brand-new' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    });

    it('does not refresh per lookup for slugs the catalog does not list', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost') as any);
      await service.getCatalogEntries(true);

      for (const slug of ['nope-one', 'nope-two', 'nope-three', 'nope-four']) {
        await expect(service.getAppInfoForUrn(`${slug}:ci-marketplace` as any)).resolves.toBeNull();
      }

      // One warm fetch plus exactly one refresh for the whole run of missing slugs.
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    });

    it('reopens the missing-slug refresh after its cooldown window', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000);
        portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost') as any);
        await service.getCatalogEntries(true);

        await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toBeNull();
        expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

        now.mockReturnValue(1_000 + 59_000);
        await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toBeNull();
        expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

        now.mockReturnValue(1_000 + 61_000);
        await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toBeNull();
        expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(3);
      } finally {
        now.mockRestore();
      }
    });

    it('shares one forced refresh between concurrent lookups for missing slugs', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
      await service.getCatalogEntries(true);

      let resolveRefresh: (value: unknown) => void = () => {};
      portalClient.fetchStoreCatalog.mockReturnValueOnce(new Promise((resolve) => (resolveRefresh = resolve)));

      const lookups = Promise.all([
        service.getAppInfoForUrn('brand-new:ci-marketplace' as any),
        service.getAppInfoForUrn('also-new:ci-marketplace' as any),
      ]);
      resolveRefresh(catalog('ghost', 'brand-new', 'also-new'));

      expect((await lookups).map((info) => info?.id)).toEqual(['brand-new', 'also-new']);
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    });

    it('resolves deprecated and unavailable apps the browseable catalog drops', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue([
        { slug: 'old-app', name: 'Old App', short_desc: 'Retired', categories: ['ai'], deprecated: true },
        { slug: 'paused-app', name: 'Paused App', short_desc: 'Unavailable', categories: ['ai'], available: false },
      ] as any);

      await expect(service.getCatalogEntries(true)).resolves.toEqual([]);
      await expect(service.getAppInfoForUrn('old-app:ci-marketplace' as any)).resolves.toMatchObject({ id: 'old-app', deprecated: true });
      await expect(service.getAppInfoForUrn('paused-app:ci-marketplace' as any)).resolves.toMatchObject({ id: 'paused-app', available: false });
      // Neither lookup counts as a missing slug, so neither triggers a refresh.
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);
    });

    it('keeps every listing field full app metadata is mapped from', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue([
        {
          slug: 'filesystem-mcp',
          name: 'Filesystem MCP',
          short_desc: 'Files over MCP',
          categories: ['ai'],
          author: 'Third Party',
          source: 'https://github.com/example/filesystem-mcp',
          website: 'https://example.com',
          port: 9123,
          version: '3.2.1',
          cihub_app_version: 7,
          runtime_platform: 'docker',
          supported_architectures: ['amd64'],
          exposable: false,
          dynamic_config: true,
          form_fields: [{ type: 'text', label: 'Root', env_variable: 'ROOT_DIR' }],
          force_pull: true,
          url_suffix: '/ui',
          hub_integration: { memory: { provider: { service: 'gateway', port: 9123 } } },
          mcp: { transport: 'stdio' },
          screenshots: ['https://cdn.example.com/one.png'],
          demo_video: 'https://cdn.example.com/demo.mp4',
          replaces: ['Dropbox'],
          // Listing rows also carry the whole compose file, which per-app metadata never reads.
          compose: { services: Array.from({ length: 50 }, (_, index) => ({ name: `svc-${index}`, image: 'x'.repeat(200) })) },
        },
      ] as any);

      await expect(service.getAppInfoForUrn('filesystem-mcp:ci-marketplace' as any)).resolves.toMatchObject({
        id: 'filesystem-mcp',
        author: 'Third Party',
        source: 'https://github.com/example/filesystem-mcp',
        website: 'https://example.com',
        port: 9123,
        version: '3.2.1',
        cihub_app_version: 7,
        runtime_platform: 'docker',
        supported_architectures: ['amd64'],
        exposable: false,
        dynamic_config: true,
        form_fields: [{ type: 'text', label: 'Root', env_variable: 'ROOT_DIR' }],
        force_pull: true,
        url_suffix: '/ui',
        hub_integration: { memory: { provider: { service: 'gateway', port: 9123 } } },
        mcp: { transport: 'stdio' },
        screenshots: ['https://cdn.example.com/one.png'],
        demo_video: 'https://cdn.example.com/demo.mp4',
        replaces: ['Dropbox'],
      });
    });

    it('serves a lookup from a catalog past its TTL and refreshes behind it', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000);
        portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
        await service.getCatalogEntries(true);

        now.mockReturnValue(1_000 + 1000 * 60 * 15);
        portalClient.fetchStoreCatalog.mockResolvedValueOnce([
          { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'], port: 2368, version: '2.0.0' },
        ] as any);

        await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ version: '1.0.0' });
        expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

        await vi.waitFor(() => expect(service.getUpdateInfoForUrn('ghost:ci-marketplace' as any)?.latestDockerVersion).toBe('2.0.0'));
        await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ version: '2.0.0' });
        expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('fetches again for a lookup after invalidateCache', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost', version: '1.0.0' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);

      service.invalidateCache();
      portalClient.fetchStoreCatalog.mockResolvedValue([
        { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'], port: 2368, version: '2.0.0' },
      ] as any);

      // The invalidated rows are gone, so the answer comes from the catalog fetched after it rather
      // than from the one the invalidate was meant to drop.
      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ version: '2.0.0' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

      // The catalog fetched after the invalidate is cached again.
      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ version: '2.0.0' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    });

    it('reopens the missing-slug refresh after invalidateCache', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue(catalog('ghost') as any);

      await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toBeNull();
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
      // Still inside the cooldown window, so a repeat of the same lookup does not refresh.
      await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toBeNull();
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);

      // An invalidate drops the catalog the window was spent proving, so the next lookup may refresh
      // again even though the window has not run out.
      service.invalidateCache();
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost', 'nope') as any);

      await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toMatchObject({ id: 'nope' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(4);
    });

    it('does not spend the missing-slug refresh on a lookup that joined a cache-busting fetch', async () => {
      let resolveWarm: (value: unknown) => void = () => {};
      portalClient.fetchStoreCatalog.mockReturnValueOnce(new Promise((resolve) => (resolveWarm = resolve)));

      // A forced warm is already in flight, so the lookup joins it instead of fetching for itself.
      const warm = service.getCatalogEntries(true);
      const lookup = service.getAppInfoForUrn('nope:ci-marketplace' as any);
      resolveWarm(catalog('ghost'));
      await warm;
      await expect(lookup).resolves.toBeNull();
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);

      // That answer already bypassed Portal's cache, so the refresh window was not spent on it and
      // the next lookup for the same slug can still force one.
      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost', 'nope') as any);
      await expect(service.getAppInfoForUrn('nope:ci-marketplace' as any)).resolves.toMatchObject({ id: 'nope' });
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(2);
    });

    it('resolves the slug a marketplace URN names, not the listing row id', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue([
        { id: 'app_01hzzk', slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'], port: 2368, version: '1.0.0' },
      ] as any);

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost' });
      await expect(service.getAppInfoForUrn('app_01hzzk:ci-marketplace' as any)).resolves.toBeNull();
    });

    it('keeps the first listing for a slug, as a scan over the rows did', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue([
        { slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'], port: 2368, version: '1.0.0' },
        { slug: 'ghost', name: 'Ghost (shadowed)', short_desc: 'Blog', categories: ['social'], port: 9999, version: '9.9.9' },
      ] as any);

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({
        name: 'Ghost',
        port: 2368,
        version: '1.0.0',
      });
    });

    it('caches only the fields per-app metadata reads, not the whole listing row', async () => {
      portalClient.fetchStoreCatalog.mockResolvedValue([
        {
          slug: 'ghost',
          name: 'Ghost',
          short_desc: 'Blog',
          categories: ['social'],
          port: 2368,
          version: '1.0.0',
          // Listing rows carry each free app's whole compose file — about half of the catalog by
          // size — plus whatever else Portal adds to the listing later.
          compose: { services: { ghost: { image: 'ghost:5', volumes: ['${APP_DATA_DIR}/data:/var/lib/ghost'] } } },
          some_future_portal_field: 'x'.repeat(1000),
        },
      ] as any);

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost' });

      const cachedRows = (service as unknown as { rawCache: Map<string, Record<string, unknown>> | null }).rawCache;
      expect(Object.keys(cachedRows?.get('ghost') ?? {}).sort()).toEqual(['categories', 'name', 'port', 'short_desc', 'slug', 'version']);
    });

    it('returns null and logs when Portal fails, without caching the failure', async () => {
      portalClient.fetchStoreCatalog.mockRejectedValueOnce(new Error('timeout of 45000ms exceeded'));

      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Portal catalog app info fetch failed for ghost:ci-marketplace'));
      // A failed Portal is not asked twice for the same lookup.
      expect(portalClient.fetchStoreCatalog).toHaveBeenCalledTimes(1);

      portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
      await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost' });
    });

    it('answers from the catalog in hand when a later Portal refresh fails', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000);
        portalClient.fetchStoreCatalog.mockResolvedValueOnce(catalog('ghost') as any);
        await service.getCatalogEntries(true);

        now.mockReturnValue(1_000 + 1000 * 60 * 15);
        portalClient.fetchStoreCatalog.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        await expect(service.getAppInfoForUrn('ghost:ci-marketplace' as any)).resolves.toMatchObject({ id: 'ghost' });
      } finally {
        now.mockRestore();
      }
    });
  });
});
