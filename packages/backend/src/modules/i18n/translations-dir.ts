import path from 'node:path';

/** Dev: packages/common/i18n/translations. Prod: assets/translations in the Hub image. */
export function resolveTranslationsDirectory(cwd = process.cwd()): string {
  const { NODE_ENV } = process.env;
  if (NODE_ENV === 'production') {
    return path.join(cwd, 'assets', 'translations');
  }
  return path.join(cwd, '..', 'common', 'i18n', 'translations');
}
