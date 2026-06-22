import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@ci-hub/common/i18n/translations/en.json';

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: en,
      },
    },
    interpolation: {
      escapeValue: false,
    },
    initImmediate: false,
  });
}

afterEach(() => {
  cleanup();
});
