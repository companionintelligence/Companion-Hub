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
    it('should load en from disk without going through i18next cache', async () => {
      (fs.existsSync as any).mockImplementation((p: string) => String(p).endsWith(`${'en'}.json`));
      (fs.readFileSync as any).mockReturnValue('{"A":"a","B":"b"}');

      const result = await service.getTranslation('en', 'translation');
      expect(result).toEqual({ A: 'a', B: 'b' });
    });

    it('should merge en with en-US overlays', async () => {
      (fs.existsSync as any).mockImplementation((p: string) => String(p).endsWith('en.json') || String(p).endsWith('en-US.json'));
      (fs.readFileSync as any).mockImplementation((p: string) => {
        if (String(p).endsWith('en.json')) return '{"SHARED":"from-en","ONLY_EN":"x"}';
        if (String(p).endsWith('en-US.json')) return '{"SHARED":"from-us"}';
        return '{}';
      });

      const result = await service.getTranslation('en-US', 'translation');
      expect(result).toEqual({ SHARED: 'from-us', ONLY_EN: 'x' });
    });

    it('should fall back to en for unknown locales when overlay is missing', async () => {
      (fs.existsSync as any).mockImplementation((p: string) => String(p).endsWith('en.json'));
      (fs.readFileSync as any).mockReturnValue('{"ONLY":"en"}');

      const result = await service.getTranslation('xx', 'translation');
      expect(result).toEqual({ ONLY: 'en' });
    });

    it('should return empty object when en.json is missing', async () => {
      (fs.existsSync as any).mockReturnValue(false);

      const result = await service.getTranslation('en', 'translation');
      expect(result).toEqual({});
    });
  });
});
