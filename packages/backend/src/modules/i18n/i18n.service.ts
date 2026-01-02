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
      const languages = files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace('.json', ''));

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
      console.error(`Failed to initialize i18n:`, error);
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
    try {
      // Normalize language code (e.g., 'en-US' -> 'en')
      const normalizedLang = language.split('-')[0];
      
      // If namespace is 'translation' (default), try to get the resource bundle
      // Otherwise, try to load it directly from the file system
      if (namespace === 'translation') {
        // Try to get from i18next cache first
        const bundle = i18n.getResourceBundle(language, namespace) || 
                      i18n.getResourceBundle(normalizedLang!, namespace);
        
        if (bundle) {
          return bundle;
        }
      }
      
      // Fallback: Load directly from file system
      let directory = path.join(process.cwd(), 'assets', 'translations');
      const { NODE_ENV } = process.env;
      if (NODE_ENV !== 'production') {
        directory = path.join(process.cwd(), 'src', 'modules', 'i18n', 'translations');
      }
      
      // Try the exact language first, then normalized
      const possibleFiles = [
        path.join(directory, `${language}.json`),
        path.join(directory, `${normalizedLang}.json`),
        path.join(directory, 'en.json'), // Final fallback
      ];
      
      for (const filePath of possibleFiles) {
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
