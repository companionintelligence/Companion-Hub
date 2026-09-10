import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';
import type { PropsWithChildren } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { client } from '@/api-client/client.gen';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';
import { isMobileClient } from '@/lib/mobile-connection';
import { runtimeFetch } from '@/lib/runtime-fetch';
import en from '@ci-hub/common/i18n/translations/en.json';

let i18nInitialized = false;

function initI18n() {
  if (i18nInitialized) return;
  i18nInitialized = true;

  const mobile = isMobileClient() || import.meta.env.VITE_HUB_RUNTIME === 'mobile';
  const chain = i18n.use(initReactI18next);

  // A phone talking to a remote Hub must not wait on `/api/i18n` — that fetch
  // is window.fetch to a cross-origin appliance and used to leave this provider
  // on "Loading…" forever. Bundled English is enough for the connect/login shell.
  if (!mobile) {
    const Backend = new HttpBackend(null, {
      loadPath: '/api/i18n/locales/{{ns}}/{{lng}}.json',
      request: (
        _options: object,
        url: string,
        _payload: object,
        callback: (err: Error | null, response: { status: number; data: string }) => void,
      ) => {
        const crossOrigin = usesCrossOriginDesktopApi();
        const fullUrl = crossOrigin ? `${client.getConfig().baseUrl ?? ''}${url}` : url;
        runtimeFetch(fullUrl, { credentials: crossOrigin ? 'omit' : 'include', signal: AbortSignal.timeout(5_000) })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then((data) => callback(null, { status: 200, data }))
          .catch((err) => callback(err, { status: 500, data: '' }));
      },
    });
    chain.use(Backend).use(LanguageDetector);
  }

  /*
   * ⚠ THE COMPILED-IN COPY IS THE FLOOR, AND IT HAS TO BE.
   *
   * `/api/i18n` is served by the BACKEND, and a Hub is routinely a build or two behind the UI
   * talking to it — a partial upgrade, a desktop app against an older appliance, or a dev server
   * proxying a remote Hub. `HttpBackend` replaces this namespace with what it fetched, so every
   * string the UI has added since that backend was built renders as its RAW KEY: a screen reading
   * `DASHBOARD_SECTION_LOCAL` where the titles should be.
   *
   * After each load, the bundled English is re-applied with `overwrite: false` — so the server
   * still wins wherever it HAS a value (which is what makes a Hub's own translations and any
   * future locale work), and the bundle fills only the gaps it has never heard of.
   *
   * `deep: true` matters: without it the merge is shallow and a nested namespace would be
   * replaced wholesale rather than topped up.
   */
  /*
   * Re-applies the compiled-in English UNDER whatever the server sent: `overwrite: false` means a
   * value the Hub actually has always wins, and `deep: true` tops up nested namespaces instead of
   * replacing them wholesale.
   */
  const applyBundledFloor = () => {
    for (const lng of ['en', 'en-US']) {
      i18n.addResourceBundle(lng, 'translation', en, true, false);
    }
  };

  // Both moments, deliberately. `loaded` alone is not enough — it can fire before `init` has
  // finished wiring the store, and the bundle it added is then replaced by the fetched namespace.
  i18n.on('loaded', applyBundledFloor);

  void chain
    .init({
      debug: false,
      lng: mobile ? 'en' : undefined,
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
    })
    .then(applyBundledFloor);
}

initI18n();

/** Never gate the tree on i18n ready — that was the phone's infinite "Loading…" screen. */
export const I18nProvider = ({ children }: PropsWithChildren) => {
  initI18n();
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
};
