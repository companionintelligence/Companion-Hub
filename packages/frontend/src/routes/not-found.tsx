import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';

export default function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    // `min-h-screen`, not `h-full`. The catch-all route sits outside both layout
    // guards, so it has no height-bearing ancestor — `h-full` resolved to the
    // content height, `justify-center` did nothing, and the page rendered jammed
    // against the top of an otherwise empty viewport.
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-4">{t('NOT_FOUND_TITLE')}</h1>
      <p className="text-lg text-center">{t('NOT_FOUND_SUBTITLE')}</p>
      <Button type="button" className="mt-6" onClick={() => navigate('/home')}>
        {t('COMMON_HOME')}
      </Button>
    </div>
  );
}
