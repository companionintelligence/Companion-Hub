import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';

export default function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <h1 className="text-4xl font-bold mb-4">{t('NOT_FOUND_TITLE')}</h1>
      <p className="text-lg text-center">{t('NOT_FOUND_SUBTITLE')}</p>
      <Button type="button" className="mt-6" onClick={() => navigate('/home')}>
        {t('COMMON_HOME')}
      </Button>
    </div>
  );
}
