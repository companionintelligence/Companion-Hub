import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { client } from '@/api-client/client.gen';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';
import en from '@ci-hub/common/i18n/translations/en.json';

let i18nInitialized = false;

function initI18n() {
  if (i18nInitialized) return;
  i18nInitialized = true;

  const Backend = new HttpBackend(null, {
    loadPath: '/api/i18n/locales/{{ns}}/{{lng}}.json',
    request: (_options: object, url: string, _payload: object, callback: (err: Error | null, response: { status: number; data: string }) => void) => {
      const crossOrigin = usesCrossOriginDesktopApi();
      const fullUrl = crossOrigin ? `${client.getConfig().baseUrl ?? ''}${url}` : url;
      fetch(fullUrl, { credentials: crossOrigin ? 'omit' : 'include' })
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
