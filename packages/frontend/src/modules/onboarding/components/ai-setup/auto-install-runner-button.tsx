import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { describePullStartError } from '@/lib/inference/tracked-models';
import { FailureLog } from './failure-log';

interface AutoInstallRunnerButtonProps {
  onRun: () => Promise<void>;
  /** What the outcome says, for an action that isn't starting a local runner. */
  labels?: { installing: string; complete: string; failed: string };
}

type InstallPhase = 'idle' | 'installing' | 'completed' | 'error';

/**
 * Native-only remediation action shared by host-run inference cards. A failure shows the reason
 * the runner gave, so the person knows what to fix.
 */
export const AutoInstallRunnerButton = ({ onRun, labels }: AutoInstallRunnerButtonProps) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InstallPhase>('idle');
  const [errorDetail, setErrorDetail] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    // Set here as well as at declaration: StrictMode's dev double-invoke runs the cleanup once
    // before the real mount, which would otherwise latch this false and leave the spinner up.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleRun = async () => {
    setPhase('installing');
    try {
      await onRun();
      if (mounted.current) setPhase('completed');
    } catch (error) {
      if (!mounted.current) return;
      // Handles the plain string a desktop command rejects with and a status check's i18n key.
      setErrorDetail(describePullStartError(error));
      setPhase('error');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="auto-install-runner">
      {phase === 'installing' ? (
        <div className="flex items-center gap-2 text-xs text-warning" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          {labels?.installing ?? t('ONBOARDING_INFERENCE_RUN_INSTALLING')}
        </div>
      ) : (
        <Button
          size="sm"
          onClick={() => void handleRun()}
          className="bg-warning text-warning-foreground hover:bg-warning/90"
          data-testid="auto-install-runner-btn"
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('ONBOARDING_INFERENCE_RUN_AUTOMATICALLY')}
        </Button>
      )}
      {phase === 'completed' && (
        <span className="flex items-center gap-1 text-xs text-success" role="status">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {labels?.complete ?? t('ONBOARDING_INFERENCE_RUN_COMPLETE')}
        </span>
      )}
      {phase === 'error' && (
        <span className="flex items-start gap-1 text-xs text-destructive" role="alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <FailureLog text={`${labels?.failed ?? t('ONBOARDING_INFERENCE_RUN_ERROR')}${errorDetail && `: ${errorDetail}`}`} />
        </span>
      )}
    </div>
  );
};
