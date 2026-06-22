import { useTranslation } from 'react-i18next';

export default function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <h1 className="text-4xl font-bold mb-4">{t('NOT_FOUND_TITLE')}</h1>
      <p className="text-lg text-center">{t('NOT_FOUND_SUBTITLE')}</p>
    </div>
  );
}
