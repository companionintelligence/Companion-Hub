import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LinksController } from '../links.controller';
import { LinksService } from '../links.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('LinksController', () => {
  let controller: LinksController;
  let linksService: MockProxy<LinksService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LinksController],
      providers: [
        { provide: LinksService, useValue: mock<LinksService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(LinksController);
    linksService = moduleRef.get(LinksService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getGuestLinks', () => {
    it('should return guest dashboard links', async () => {
      const mockLinks = [{ id: 1, title: 'Test', url: 'https://test.com', iconUrl: null, description: null, userId: null }];
      linksService.getGuestDashboardLinks.mockResolvedValue(mockLinks as any);

      const result = await controller.getGuestLinks();
      expect(result).toBeDefined();
      expect(linksService.getGuestDashboardLinks).toHaveBeenCalled();
    });
  });

  describe('getLinks', () => {
    it('should return links for authenticated user', async () => {
      const mockLinks = [{ id: 1, title: 'Test', url: 'https://test.com', iconUrl: null, description: null, userId: 1 }];
      linksService.getLinks.mockResolvedValue(mockLinks as any);
      const req = { user: { id: 1 } } as any;

      const result = await controller.getLinks(req);
      expect(result).toBeDefined();
      expect(linksService.getLinks).toHaveBeenCalledWith(1);
    });
  });

  describe('createLink', () => {
    it('should throw if not logged in', async () => {
      const req = { user: undefined } as any;
      await expect(controller.createLink({ title: 'Test', url: 'https://test.com' } as any, req)).rejects.toThrow();
    });

    it('should create a link for authenticated user', async () => {
      const body = { title: 'Test', url: 'https://test.com' } as any;
      const req = { user: { id: 1 } } as any;
      linksService.add.mockResolvedValue({ id: 1 } as any);

      await controller.createLink(body, req);
      expect(linksService.add).toHaveBeenCalledWith(body, 1);
    });
  });

  describe('deleteLink', () => {
    it('should throw if not logged in', async () => {
      const req = { user: undefined } as any;
      await expect(controller.deleteLink(1, req)).rejects.toThrow();
    });

    it('should delete a link', async () => {
      const req = { user: { id: 1 } } as any;
      linksService.delete.mockResolvedValue(undefined as any);

      await controller.deleteLink(1, req);
      expect(linksService.delete).toHaveBeenCalledWith(1, 1);
    });
  });
});
