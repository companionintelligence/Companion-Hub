import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { I18nController } from '../i18n.controller';
import { I18nService } from '../i18n.service';

describe('I18nController', () => {
  let controller: I18nController;
  let i18nService: MockProxy<I18nService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [I18nController],
      providers: [{ provide: I18nService, useValue: mock<I18nService>() }],
    }).compile();

    controller = moduleRef.get(I18nController);
    i18nService = moduleRef.get(I18nService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getTranslation', () => {
    it('should return translations for a given locale and namespace', async () => {
      const translations = { hello: 'Hello', goodbye: 'Goodbye' };
      i18nService.getTranslation.mockResolvedValue(translations);

      const result = await controller.getTranslation('common', 'en');
      expect(result).toEqual(translations);
      expect(i18nService.getTranslation).toHaveBeenCalledWith('en', 'common');
    });

    it('should return empty object when translations not found', async () => {
      i18nService.getTranslation.mockResolvedValue(null as any);

      const result = await controller.getTranslation('common', 'xx');
      expect(result).toEqual({});
    });

    it('should return empty object on error', async () => {
      i18nService.getTranslation.mockRejectedValue(new Error('File not found'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await controller.getTranslation('common', 'xx');
      expect(result).toEqual({});

      consoleSpy.mockRestore();
    });
  });
});
