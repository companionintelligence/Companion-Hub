import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import i18n from 'i18next';
import Backend, { type FsBackendOptions } from 'i18next-fs-backend';
import { resolveTranslationsDirectory } from './translations-dir';

/**
 * A language tag as a locale file is named: letters, digits, `-` and `_`, starting with a
 * 2-3 letter language. No `.` and no path separator, so a tag can never name anything but a
 * file directly inside the translations folder.
 *
 * ⚠ `language` COMES STRAIGHT FROM THE URL (`GET /api/i18n/locales/:ns/:lng.json`, which has
 * no auth guard), and Express decodes `%2F` in a route parameter. Joined unchecked into a
 * path, `..%2F..%2Fdata%2Fstate%2Fsettings` read the Hub's own settings file back to any
 * caller who could reach the port.
 */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

export const isSafeLanguageTag = (language: string): boolean => LANGUAGE_TAG.test(language);

@Injectable()
export class I18nService {
  constructor() {
    const directory = resolveTranslationsDirectory();

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

  async getTranslation(language: string, namespace: string) {
    if (!isSafeLanguageTag(language)) {
      return {};
    }

    try {
      // Normalize language code (e.g., 'en-US' -> 'en')
      const normalizedLang = language.split('-')[0] ?? language;

      // If namespace is 'translation' (default), try to get the resource bundle
      // Otherwise, try to load it directly from the file system
      if (namespace === 'translation') {
        // Try to get from i18next cache first
        const bundle = i18n.getResourceBundle(language, namespace) || i18n.getResourceBundle(normalizedLang, namespace);

        if (bundle) {
          return bundle;
        }
      }

      // Fallback: Load directly from file system
      const directory = resolveTranslationsDirectory();

      // Try the exact language first, then normalized
      const possibleFiles = [
        path.join(directory, `${language}.json`),
        path.join(directory, `${normalizedLang}.json`),
        path.join(directory, 'en.json'), // Final fallback
      ];

      for (const filePath of possibleFiles) {
        // Belt and braces behind the tag check: whatever the name, it must resolve to a file
        // directly inside the translations folder.
        if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) {
          continue;
        }

        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          return JSON.parse(content);
        }
      }

      // If nothing found, return empty object
      return {};
    } catch (error) {
      console.error(`Failed to get translation for ${language}/${namespace}:`, error);
      return {};
    }
  }
}
