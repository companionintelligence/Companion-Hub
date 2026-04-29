import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LinkTools } from '../../tools/link.tools';
import { LinksService } from '@/modules/links/links.service';

describe('LinkTools', () => {
  let tools: LinkTools;
  let linksService: MockProxy<LinksService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LinkTools, { provide: LinksService, useValue: mock<LinksService>() }],
    }).compile();
    tools = module.get<LinkTools>(LinkTools);
    linksService = module.get(LinksService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_list_links', () => {
    it('should return array of links', async () => {
      linksService.getLinks.mockResolvedValue([{ id: 1, title: 'Test', url: 'https://test.com' }] as any);
      const result = await tools.listLinks();
      expect(result.links).toHaveLength(1);
    });
    it('should return empty array when no links exist', async () => {
      linksService.getLinks.mockResolvedValue([]);
      const result = await tools.listLinks();
      expect(result.links).toEqual([]);
    });
  });

  describe('hub_create_link', () => {
    it('should create a link and return the created link object', async () => {
      linksService.add.mockResolvedValue({ id: 1, title: 'New', url: 'https://new.com' } as any);
      const result = await tools.createLink({ title: 'New', url: 'https://new.com' });
      expect(linksService.add).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('hub_edit_link', () => {
    it('should update an existing link', async () => {
      linksService.edit.mockResolvedValue({ id: 1, title: 'Updated' } as any);
      const result = await tools.editLink({ linkId: 1, title: 'Updated' });
      expect(linksService.edit).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Updated' }), 1);
    });
  });

  describe('hub_delete_link', () => {
    it('should delete the specified link', async () => {
      linksService.delete.mockResolvedValue(undefined as any);
      await tools.deleteLink({ linkId: 1 });
      expect(linksService.delete).toHaveBeenCalledWith(1, 1);
    });
    it('should return error when deleting a non-existent link', async () => {
      linksService.delete.mockRejectedValue(new Error('Not found'));
      await expect(tools.deleteLink({ linkId: 999 })).rejects.toThrow();
    });
  });
});
