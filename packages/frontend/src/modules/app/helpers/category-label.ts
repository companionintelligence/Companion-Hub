import type { TFunction } from 'i18next';

function toTitleCase(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getCategoryLabel(t: TFunction, category: string) {
  const raw = (category || '').trim();
  if (!raw) return '';

  // Accept either "utilities" or "APP_CATEGORY_UTILITIES" style inputs.
  const keySuffix = raw
    .replace(/^APP_CATEGORY_/i, '')
    .replace(/-/g, '_')
    .toUpperCase();
  const translationKey = `APP_CATEGORY_${keySuffix}`;
  const translated = t(translationKey);

  // i18next returns the key itself when no translation exists.
  if (translated && translated !== translationKey) {
    return translated;
  }

  // Some category labels were deduplicated to COMMON_* keys.
  const commonKey = `COMMON_${keySuffix}`;
  const commonTranslated = t(commonKey);
  if (commonTranslated && commonTranslated !== commonKey) {
    return commonTranslated;
  }

  return toTitleCase(keySuffix.replace(/_/g, ' '));
}
