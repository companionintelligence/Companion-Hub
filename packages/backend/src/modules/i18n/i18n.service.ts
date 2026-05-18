import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import i18n from 'i18next';
import Backend, { type FsBackendOptions } from 'i18next-fs-backend';

@Injectable()
export class I18nService {
  constructor() {
    let directory = path.join(process.cwd(), 'assets', 'translations');

    const { NODE_ENV } = process.env;
    if (NODE_ENV !== 'production') {
      directory = path.join(process.cwd(), 'src', 'modules', 'i18n', 'translations');
    }

    // Ensure directory exists before trying to read it
    if (!fs.existsSync(directory)) {
      console.error(`Translation directory does not exist: ${directory}`);
      // Initialize with empty translations to prevent crashes
      i18n.use(Backend).init<FsBackendOptions>({
        initAsync: false,
        fallbackLng: 'en',
        lng: 'en',
        preload: [],
        backend: {
          loadPath: path.join(directory, '{{lng}}.json'),
        },
      });
      return;
    }

    try {
      const files = fs.readdirSync(directory);
      const languages = files.filter((file) => file.endsWith('.json')).map((file) => file.replace('.json', ''));

      i18n.use(Backend).init<FsBackendOptions>({
        initAsync: false,
        fallbackLng: 'en',
        lng: 'en',
        preload: languages,
        backend: {
          loadPath: path.join(directory, '{{lng}}.json'),
        },
      });
    } catch (error) {
      console.error('Failed to initialize i18n:', error);
      // Initialize with empty translations to prevent crashes
      i18n.use(Backend).init<FsBackendOptions>({
        initAsync: false,
        fallbackLng: 'en',
        lng: 'en',
        preload: [],
        backend: {
          loadPath: path.join(directory, '{{lng}}.json'),
        },
      });
    }
  }

  private getTranslationsDirectory(): string {
    const { NODE_ENV } = process.env;
    if (NODE_ENV !== 'production') {
      return path.join(process.cwd(), 'src', 'modules', 'i18n', 'translations');
    }
    return path.join(process.cwd(), 'assets', 'translations');
  }

  private readLocaleFile(directory: string, lng: string): Record<string, string> | null {
    const filePath = path.join(directory, `${lng}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, string>;
    } catch {
      return null;
    }
  }

  /**
   * Serve locale bundles from disk and merge `en` with region/locale files.
   * Do not rely on i18next's in-memory cache here: it can return a partial bundle
   * for `en-US`, which caused the UI to show raw i18n keys for newer strings.
   */
  async getTranslation(language: string, namespace: string) {
    try {
      void namespace;

      const directory = this.getTranslationsDirectory();
      const normalizedLang = language.split('-')[0] ?? language;

      const base = this.readLocaleFile(directory, 'en') ?? {};

      if (language === 'en') {
        return base;
      }

      const exact = this.readLocaleFile(directory, language);
      const regional = language !== normalizedLang && language.includes('-') ? this.readLocaleFile(directory, normalizedLang) : null;

      return {
        ...base,
        ...(regional ?? {}),
        ...(exact ?? {}),
      };
    } catch (error) {
      console.error(`Failed to get translation for ${language}/${namespace}:`, error);
      return {};
    }
  }
}
