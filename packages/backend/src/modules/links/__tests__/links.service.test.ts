import { Test, TestingModule } from '@nestjs/testing';
import { LinksService } from '../links.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LinksRepository } from '../links.repository';
import { mock, MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { describe, it, expect, beforeEach } from 'vitest';

describe('LinksService', () => {
  let service: LinksService;
  let configService: MockProxy<ConfigurationService>;
  let linksRepository: MockProxy<LinksRepository>;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    linksRepository = mock<LinksRepository>();

    configService.get.mockReturnValue(false); // Default: not demo mode

    const module: TestingModule = await Test.createTestingModule({
      providers: [LinksService, { provide: ConfigurationService, useValue: configService }, { provide: LinksRepository, useValue: linksRepository }],
    }).compile();

    service = module.get<LinksService>(LinksService);
  });

  describe('add', () => {
    it('should add a link', async () => {
      const linkDto = { name: 'Link', url: 'http://example.com' };
      linksRepository.addLink.mockResolvedValue({ id: 1, ...linkDto } as any);

      const result = await service.add(linkDto as any, 1);

      expect(linksRepository.addLink).toHaveBeenCalledWith(linkDto, 1);
      expect(result).toEqual({ id: 1, ...linkDto });
    });

    it('should throw in demo mode', async () => {
      configService.get.mockReturnValue(true);

      const linkDto = { name: 'Link', url: 'http://example.com' };

      await expect(service.add(linkDto as any, 1)).rejects.toThrow(TranslatableError);
    });
  });

  describe('edit', () => {
    it('should edit a link', async () => {
      const linkDto = { name: 'Link Updated' };
      linksRepository.editLink.mockResolvedValue({ id: 1, ...linkDto } as any);

      const result = await service.edit(1, linkDto as any, 1);

      expect(linksRepository.editLink).toHaveBeenCalledWith(1, linkDto, 1);
      expect(result).toEqual({ id: 1, ...linkDto });
    });
  });

  describe('delete', () => {
    it('should delete a link', async () => {
      linksRepository.deleteLink.mockResolvedValue(true as any);

      const result = await service.delete(1, 1);
      expect(linksRepository.deleteLink).toHaveBeenCalledWith(1, 1);
      expect(result).toBe(true);
    });
  });

  describe('getLinks', () => {
    it('should return links for user', async () => {
      linksRepository.getLinks.mockResolvedValue([{ id: 1 }] as any);

      const result = await service.getLinks(1);
      expect(linksRepository.getLinks).toHaveBeenCalledWith(1);
      expect(result).toHaveLength(1);
    });

    it('should return empty array if no user id', async () => {
      const result = await service.getLinks(undefined);
      expect(result).toEqual([]);
      expect(linksRepository.getLinks).not.toHaveBeenCalled();
    });
  });
});
