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
          .then((data) => {
            /*
             * ⚠ MERGED HERE, BEFORE i18next EVER SEES IT, AND THAT PLACEMENT IS THE FIX.
             *
             * The obvious approach — let the fetch land, then re-apply the bundle over the top
             * with `overwrite: false` — is a RACE. It only wins when the re-apply happens after
             * `addResourceBundle`, and whether it does depends on whether `loaded` fires before
             * or after `init` finishes wiring the store. It passed once and then silently
             * stopped, putting 175 raw keys back on the resource dashboard.
             *
             * Merging into the PAYLOAD has no ordering to lose: whatever i18next stores already
             * contains every key this frontend shipped with. The server still wins on every key
             * it actually has — it is spread last — which is what keeps a Hub's own translations
             * and any future locale working.
             *
             * A malformed body is returned untouched so the existing error path still runs.
             */
            try {
              const fetched = JSON.parse(data) as Record<string, unknown>;
              return callback(null, { status: 200, data: JSON.stringify({ ...en, ...fetched }) });
            } catch {
              return callback(null, { status: 200, data });
            }
          })
          .catch((err) => callback(err, { status: 500, data: '' }));
      },
    });
    chain.use(Backend).use(LanguageDetector);
  }

  void chain.init({
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
  });
}

initI18n();

/** Never gate the tree on i18n ready — that was the phone's infinite "Loading…" screen. */
export const I18nProvider = ({ children }: PropsWithChildren) => {
  initI18n();
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
};
