import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { client } from '@/api-client/client.gen';
import en from '@ci-hub/common/i18n/translations/en.json';

const isTauriRelease = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !window.location.origin.startsWith('http://localhost:');

let i18nInitialized = false;

function initI18n() {
  if (i18nInitialized) return;
  i18nInitialized = true;

  const Backend = new HttpBackend(null, {
    loadPath: '/api/i18n/locales/{{ns}}/{{lng}}.json',
    // Override the request function for Tauri release mode to prefix baseUrl
    request: (_options: object, url: string, _payload: object, callback: (err: Error | null, response: { status: number; data: string }) => void) => {
      const fullUrl = isTauriRelease ? `${client.getConfig().baseUrl ?? ''}${url}` : url;
      fetch(fullUrl, { credentials: isTauriRelease ? 'omit' : 'include' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((data) => callback(null, { status: 200, data }))
        .catch((err) => callback(err, { status: 500, data: '' }));
    },
  });

  i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      debug: false,
      resources: {
        en: {
          translation: en,
        },
        'en-US': {
          translation: en,
        },
      },
      react: {
        // Suspense without a boundary above HubStatus caused a blank Tauri window
        // while non-English locales loaded (or failed) from the API.
        useSuspense: false,
      },
      fallbackLng: 'en',
      partialBundledLanguages: true,
      load: 'currentOnly',
      interpolation: {
        escapeValue: false,
      },
    });
}

export const I18nProvider = ({ children }: PropsWithChildren) => {
  const [ready, setReady] = useState(i18nInitialized && i18n.isInitialized);

  useEffect(() => {
    initI18n();
    if (i18n.isInitialized) {
      setReady(true);
    } else {
      i18n.on('initialized', () => setReady(true));
    }
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted-foreground" role="status" aria-busy="true">
        Loading…
      </div>
    );
  }

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
};
