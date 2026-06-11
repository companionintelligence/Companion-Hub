import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com';
/** After a successful install, poll status until the service comes up. */
const POST_INSTALL_RECHECK_ATTEMPTS = 10;
const POST_INSTALL_RECHECK_DELAY_MS = 2000;

interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  bridgeUnreachable?: boolean;
  displayEndpoint?: string;
  hint?: string;
  error?: string;
}

interface OllamaSetupCardProps {
  status: OllamaStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

type OllamaInstallPhase = 'idle' | 'installing' | 'completed' | 'error';

function isBridgeRefused(status: OllamaStatus): boolean {
  return status.bridgeUnreachable === true;
}

export const OllamaSetupCard = ({ status, checking, onRecheck }: OllamaSetupCardProps) => {
  const { t } = useTranslation();
  const [installPhase, setInstallPhase] = useState<OllamaInstallPhase>('idle');
  const [installError, setInstallError] = useState('');
  const unmounted = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(
    () => () => {
      unmounted.current = true;
    },
    [],
  );

  const canAutoInstall = getTauriInvoke() !== null;

  const handleAutoInstall = useCallback(async () => {
    const invoke = getTauriInvoke();
    if (!invoke) return;
    setInstallPhase('installing');
    setInstallError('');
    try {
      await invoke('install_ollama_command');
      if (unmounted.current) return;
      setInstallPhase('completed');
      for (let i = 0; i < POST_INSTALL_RECHECK_ATTEMPTS; i++) {
        if (unmounted.current || statusRef.current?.ready) break;
        await onRecheck();
        await new Promise((resolve) => setTimeout(resolve, POST_INSTALL_RECHECK_DELAY_MS));
      }
    } catch (err) {
      if (unmounted.current) return;
      setInstallError(err instanceof Error ? err.message : String(err));
      setInstallPhase('error');
    }
  }, [onRecheck]);

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_OLLAMA_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_OLLAMA_LOOKING_MACHINE')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? status.endpointUrl;

    return (
      <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
        <CardContent className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-medium text-green-900 dark:text-green-100">{t('ONBOARDING_OLLAMA_DETECTED')}</div>
                <div className="text-xs text-green-700 dark:text-green-300">{endpoint}</div>
                {status.hint && <div className="mt-1 text-xs text-green-700/90 dark:text-green-300/90">{status.hint}</div>}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} aria-label={t('ONBOARDING_OLLAMA_RECHECK')} className="shrink-0">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const bridgeUnreachable = isBridgeRefused(status);
  const title = bridgeUnreachable ? t('ONBOARDING_OLLAMA_NOT_REACHABLE') : t('ONBOARDING_OLLAMA_NOT_DETECTED');
  const description = bridgeUnreachable ? (
    (status.hint ?? t('ONBOARDING_OLLAMA_BRIDGE_UNREACHABLE_DESC'))
  ) : (
    <>
      {t('ONBOARDING_OLLAMA_NOT_INSTALLED_PREFIX')}{' '}
      <a
        href={OLLAMA_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2 hover:text-yellow-900 dark:hover:text-yellow-100"
      >
        {t('ONBOARDING_OLLAMA_SITE')}
      </a>
      {t('ONBOARDING_OLLAMA_NOT_INSTALLED_SUFFIX')}
    </>
  );

  return (
    <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-yellow-900 dark:text-yellow-100 mb-1">{title}</div>
            <div className="text-xs text-yellow-700 dark:text-yellow-300 mb-3">{description}</div>
            {status.error && <div className="mb-3 text-xs text-yellow-800 dark:text-yellow-200 font-mono">{status.error}</div>}
            {status.hint && !bridgeUnreachable && <div className="mb-3 text-xs text-yellow-800 dark:text-yellow-200">{status.hint}</div>}
            {installPhase === 'completed' && (
              <div className="mb-3 flex items-center gap-2 text-xs text-yellow-800 dark:text-yellow-200">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {t('ONBOARDING_OLLAMA_INSTALL_SUCCESS')}
              </div>
            )}
            {installPhase === 'error' && (
              <div className="mb-3 flex items-start gap-2 text-xs text-yellow-800 dark:text-yellow-200">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{installError || t('ONBOARDING_OLLAMA_INSTALL_ERROR')}</span>
              </div>
            )}
            {installPhase === 'installing' ? (
              <div className="flex items-center gap-2 text-xs text-yellow-800 dark:text-yellow-200">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {t('ONBOARDING_OLLAMA_INSTALLING')}
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {!bridgeUnreachable && canAutoInstall && (
                  <Button size="sm" onClick={handleAutoInstall} className="bg-yellow-600 hover:bg-yellow-700 text-white">
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    {t('ONBOARDING_OLLAMA_AUTO_INSTALL')}
                  </Button>
                )}
                {!bridgeUnreachable && (
                  <Button
                    size="sm"
                    variant={canAutoInstall ? 'ghost' : undefined}
                    onClick={() => openExternal(OLLAMA_DOWNLOAD_URL)}
                    className={canAutoInstall ? undefined : 'bg-yellow-600 hover:bg-yellow-700 text-white'}
                  >
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    {t('ONBOARDING_OLLAMA_GET')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  {t('ONBOARDING_OLLAMA_RECHECK')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
