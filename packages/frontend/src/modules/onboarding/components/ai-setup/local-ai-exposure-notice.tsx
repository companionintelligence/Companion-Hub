import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { fetchLocalAiNetworkExposure, isExposedToNetwork, type LocalAiNetworkExposure, protectLocalAi } from '@/lib/inference/local-ai-exposure';
import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Says so when this computer's AI servers can be reached from the network, and offers to keep them
 * off it. Shown only in the desktop app, on a computer where the guard is missing: installs from
 * before it, or one whose guard was removed. Renders nothing otherwise.
 */
export const LocalAiExposureNotice = () => {
  const { t } = useTranslation();
  const [exposure, setExposure] = useState<LocalAiNetworkExposure | null>(null);
  const [protecting, setProtecting] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setExposure(await fetchLocalAiNetworkExposure());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const protect = async () => {
    setProtecting(true);
    setError('');
    try {
      await protectLocalAi();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProtecting(false);
    }
  };

  if (!isExposedToNetwork(exposure)) return null;

  return (
    <Alert variant="warning" className="mt-3" data-testid="local-ai-exposure-notice">
      <AlertIcon>
        <ShieldAlert />
      </AlertIcon>
      <div>
        <AlertHeading className="text-sm">{t('LOCAL_AI_EXPOSED_TITLE')}</AlertHeading>
        <AlertDescription className="text-xs">
          <p>{t('LOCAL_AI_EXPOSED_DESCRIPTION')}</p>
          {exposure?.canProtect ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void protect()} loading={protecting}>
              {t('LOCAL_AI_EXPOSED_PROTECT')}
            </Button>
          ) : (
            <p className="mt-1">{t('LOCAL_AI_EXPOSED_MANUAL')}</p>
          )}
          {error && (
            <p className="mt-2 text-destructive" role="status">
              {error}
            </p>
          )}
        </AlertDescription>
      </div>
    </Alert>
  );
};
