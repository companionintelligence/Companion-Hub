import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { type Locale, locales } from '@/lib/i18n/locales';
import i18next from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';

type IProps = {
  showLabel?: boolean;
  locale?: string;
};

const DEFAULT_LOCALE: Locale = 'en-US';

const resolveSupportedLocale = (value?: string): Locale => {
  if (!value) return DEFAULT_LOCALE;
  if (value in locales) return value as Locale;

  const base = value.split('-')[0]?.toLowerCase();
  if (!base) return DEFAULT_LOCALE;

  const matched = Object.keys(locales).find((key) => key.toLowerCase().startsWith(`${base}-`));
  return (matched as Locale | undefined) ?? DEFAULT_LOCALE;
};

const LanguageSelectorLabel = () => {
  const { t } = useTranslation();

  return <span>{t('SETTINGS_GENERAL_LANGUAGE')}</span>;
};

export const LanguageSelector = (props: IProps) => {
  const { locale: initialLocale } = props;
  const [locale, setLocale] = React.useState<Locale>(() => resolveSupportedLocale(initialLocale));
  const { t } = useTranslation();
  const { showLabel = false } = props;

  React.useEffect(() => {
    setLocale(resolveSupportedLocale(initialLocale));
  }, [initialLocale]);

  const onChange = (newLocale: Locale) => {
    i18next.changeLanguage(newLocale);
    setLocale(newLocale);
  };

  return (
    <Select value={locale} onValueChange={onChange}>
      <SelectTrigger className="mb-3 pe-3" name="language" label={showLabel && <LanguageSelectorLabel />}>
        <SelectValue placeholder={t('SETTINGS_GENERAL_LANGUAGE')} />
      </SelectTrigger>
      <SelectContent>
        {Object.keys(locales).map((key) => (
          <SelectItem key={key} value={key}>
            {locales[key as Locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
