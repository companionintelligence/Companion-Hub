import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import { useLiveSession } from '@/lib/inference/live-session';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import type { OllamaStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Info, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FailureLog } from './failure-log';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com';
const OLLAMA_DOCS_URL = 'https://docs.ollama.com';
/** After a successful install, poll status until the service comes up. */
const POST_INSTALL_RECHECK_ATTEMPTS = 10;
const POST_INSTALL_RECHECK_DELAY_MS = 2000;

interface OllamaSetupCardProps {
  status: OllamaStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

type OllamaInstallPhase = 'idle' | 'installing' | 'completed' | 'error';

/**
 * Any classified bridge failure — filtered, refused or dns. Named for the
 * question it answers ("can the Hub reach it?"), not for one specific cause;
 * {@link isFirewallBlocked} is the narrower check.
 */
function isBridgeUnreachable(status: OllamaStatus): boolean {
  return status.bridgeUnreachable === true;
}

/**
 * A firewall is dropping the packets — Ollama is installed and running, so
 * offering to install it again would send the operator down the wrong path.
 */
function isFirewallBlocked(status: OllamaStatus): boolean {
  return status.failureMode === 'filtered';
}

export const OllamaSetupCard = ({ status, checking, onRecheck }: OllamaSetupCardProps) => {
  const { t } = useTranslation();
  const [installPhase, setInstallPhase] = useState<OllamaInstallPhase>('idle');
  const [installError, setInstallError] = useState('');
  const unmounted = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    // StrictMode's dev double-invoke runs the cleanup once before the real mount, which would
    // otherwise latch this true and leave the install spinner up for good.
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const canAutoInstall = getTauriInvoke() !== null;
  const liveSession = useLiveSession();

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
      <Card className="border-success/30 bg-success/10">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-success">{t('ONBOARDING_OLLAMA_DETECTED')}</div>
                <div className="text-xs text-success">{endpoint}</div>
                {status.hint && <div className="mt-1 text-xs text-success">{status.hint}</div>}
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_OLLAMA_RECHECK')}
              data-testid="ollama-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (liveSession?.ollamaBlocked) {
    return (
      <Card className="border-warning/30 bg-warning/10">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="flex-1 text-warning" data-testid="ollama-live-session">
              <div className="mb-1 text-sm font-medium">{t('ONBOARDING_OLLAMA_LIVE_SESSION_TITLE')}</div>
              <div className="mb-3 text-xs">{t('ONBOARDING_OLLAMA_LIVE_SESSION_DESC')}</div>
              {/* The drop-in only stops the service: someone can still run `ollama serve` themselves. */}
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="ollama-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_OLLAMA_RECHECK')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const bridgeUnreachable = isBridgeUnreachable(status);
  const firewallBlocked = isFirewallBlocked(status);
  const title = bridgeUnreachable ? t('ONBOARDING_OLLAMA_NOT_REACHABLE') : t('ONBOARDING_OLLAMA_NOT_DETECTED');
  const description = bridgeUnreachable ? (
    (status.hint ?? t('ONBOARDING_OLLAMA_BRIDGE_UNREACHABLE_DESC'))
  ) : (
    <>
      {t('ONBOARDING_OLLAMA_NOT_INSTALLED_PREFIX')}{' '}
      <a href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2 hover:text-warning">
        {t('ONBOARDING_OLLAMA_SITE')}
      </a>
      {t('ONBOARDING_OLLAMA_NOT_INSTALLED_SUFFIX')}
    </>
  );

  return (
    <Card className="border-warning/30 bg-warning/10">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-warning mb-1">{title}</div>
            <div className="text-xs text-warning mb-3">{description}</div>
            {status.error && <div className="mb-3 text-xs text-warning font-mono">{status.error}</div>}
            {status.hint && !bridgeUnreachable && <div className="mb-3 text-xs text-warning">{status.hint}</div>}
            {status.remediationCommand && (
              <div className="mb-3" data-testid="ollama-remediation-command">
                <div className="mb-1 text-xs font-medium text-warning">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block overflow-x-auto whitespace-pre rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            {installPhase === 'completed' && (
              <div className="mb-3 flex items-center gap-2 text-xs text-success">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {t('ONBOARDING_OLLAMA_INSTALL_SUCCESS')}
              </div>
            )}
            {installPhase === 'error' && (
              <div className="mb-3 flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <FailureLog text={installError || t('ONBOARDING_OLLAMA_INSTALL_ERROR')} testId="ollama-install-error" />
              </div>
            )}
            {installPhase === 'installing' ? (
              <div className="flex items-center gap-2 text-xs text-warning">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {t('ONBOARDING_OLLAMA_INSTALLING')}
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {canAutoInstall && !firewallBlocked && (
                  <Button size="sm" onClick={handleAutoInstall} className="bg-warning text-warning-foreground hover:bg-warning/90">
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    {t('ONBOARDING_OLLAMA_AUTO_INSTALL')}
                  </Button>
                )}
                {!bridgeUnreachable && (
                  <Button
                    size="sm"
                    variant={canAutoInstall ? 'ghost' : undefined}
                    onClick={() => openExternal(OLLAMA_DOWNLOAD_URL)}
                    className={canAutoInstall ? undefined : 'bg-warning text-warning-foreground hover:bg-warning/90'}
                  >
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    {t('ONBOARDING_OLLAMA_GET')}
                  </Button>
                )}
                {bridgeUnreachable && (
                  <Button size="sm" variant="ghost" onClick={() => openExternal(OLLAMA_DOCS_URL)} data-testid="ollama-docs-btn">
                    {t('ONBOARDING_OLLAMA_DOCS')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="ollama-recheck-btn">
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
