import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, MockProxy } from 'vitest-mock-extended';
import { PortalCatalogService } from '../portal-catalog.service';
import { PortalClientService } from '../portal-client.service';

describe('PortalCatalogService', () => {
  let service: PortalCatalogService;
  let portalClient: MockProxy<PortalClientService>;
  let configuration: MockProxy<ConfigurationService>;
  let logger: MockProxy<LoggerService>;

  beforeEach(() => {
    portalClient = mock<PortalClientService>();
    configuration = mock<ConfigurationService>();
    logger = mock<LoggerService>();
    configuration.getConfig.mockReturnValue({ architecture: 'amd64' } as any);
    portalClient.getPublicPortalUrl.mockReturnValue('https://portal.example.com');
    portalClient.fetchStoreMetadataText.mockResolvedValue(null);
    service = new PortalCatalogService(portalClient, configuration, logger);
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
        id: 'ci-import-tools',
        name: 'CI Import Tools',
        shortDescription: 'Import tooling',
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
      id: 'ci-import-tools',
      urn: 'ci-import-tools:ci-marketplace',
    });
  });

  it('searchCatalog returns entries with id', async () => {
    portalClient.fetchStoreCatalog.mockResolvedValue([{ slug: 'ghost', name: 'Ghost', short_desc: 'Blog', categories: ['social'] }] as any);

    const result = await service.searchCatalog({ pageSize: 50 });

    expect(result?.data).toHaveLength(1);
    expect(result?.data[0]?.id).toBe('ghost');
    expect(result?.data[0]?.urn).toBe('ghost:ci-marketplace');
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
});
