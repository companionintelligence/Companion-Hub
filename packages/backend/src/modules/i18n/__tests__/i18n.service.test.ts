import { Test, TestingModule } from '@nestjs/testing';
import { I18nService } from '../i18n.service';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import i18n from 'i18next';

vi.mock('node:fs');
vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    getResourceBundle: vi.fn(),
  },
}));

describe('I18nService', () => {
  let service: I18nService;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Default mocks
    (i18n.use as any).mockReturnThis();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(['en.json', 'fr.json']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [I18nService],
    }).compile();

    service = module.get<I18nService>(I18nService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize i18n with languages found', () => {
      expect(i18n.use).toHaveBeenCalled();
      expect(i18n.init).toHaveBeenCalledWith(
        expect.objectContaining({
          preload: ['en', 'fr'],
        }),
      );
    });

    it('should handle missing directory gracefully', async () => {
      vi.resetAllMocks();
      (fs.existsSync as any).mockReturnValue(false);
      (i18n.use as any).mockReturnThis();

      // Re-create service to trigger constructor
      new I18nService();

      expect(i18n.init).toHaveBeenCalledWith(
        expect.objectContaining({
          preload: [],
        }),
      );
    });
  });

  describe('getTranslation', () => {
    it('should return cached bundle if available', async () => {
      (i18n.getResourceBundle as any).mockReturnValue({ hello: 'world' });

      const result = await service.getTranslation('en', 'translation');
      expect(result).toEqual({ hello: 'world' });
    });

    it('should fallback to file system if not in cache', async () => {
      (i18n.getResourceBundle as any).mockReturnValue(undefined);

      // Mock fs for fallback logic
      (fs.existsSync as any).mockImplementation((path: string) => path.endsWith('en.json'));
      (fs.readFileSync as any).mockReturnValue('{"hello": "fs-world"}');

      const result = await service.getTranslation('en', 'translation');
      expect(result).toEqual({ hello: 'fs-world' });
    });

    it('should normalize language code', async () => {
      (i18n.getResourceBundle as any).mockImplementation((lang: any) => {
        if (lang === 'en') return { hello: 'normalized' };
        return undefined;
      });

      const result = await service.getTranslation('en-US', 'translation');
      expect(result).toEqual({ hello: 'normalized' });
    });

    it('should return empty object if nothing found', async () => {
      (i18n.getResourceBundle as any).mockReturnValue(undefined);
      (fs.existsSync as any).mockReturnValue(false);

      const result = await service.getTranslation('xx', 'invalid');
      expect(result).toEqual({});
    });
  });
});
