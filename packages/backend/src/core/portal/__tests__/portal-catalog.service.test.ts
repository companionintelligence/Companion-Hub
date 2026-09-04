import { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalCatalogService } from '../portal-catalog.service';
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
    expect(portalClient.fetchStoreCatalog).toHaveBeenCalledWith({ bypassCache: true });
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
    expect(portalClient.fetchStoreCatalog).toHaveBeenLastCalledWith({ bypassCache: true });

    const cached = await service.getCatalogEntries(false);
    expect(cached[0]?.version).toBe('2026.8.23');
    // The stale caller may still resolve to the catalog it requested; it must
    // not republish over the force-refresh cache.
    expect(['2026.8.18', '2026.8.23']).toContain(stale[0]?.version);
  });
});
