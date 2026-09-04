import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';

interface AutoInstallRunnerButtonProps {
  onRun: () => Promise<void>;
}

type InstallPhase = 'idle' | 'installing' | 'completed' | 'error';

/**
 * Native-only remediation action shared by host-run inference cards. The
 * result detail stays in desktop logs; onboarding only needs a compact,
 * backend-neutral success/error state.
 */
export const AutoInstallRunnerButton = ({ onRun }: AutoInstallRunnerButtonProps) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InstallPhase>('idle');
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleRun = async () => {
    setPhase('installing');
    try {
      await onRun();
      if (mounted.current) setPhase('completed');
    } catch {
      if (mounted.current) setPhase('error');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="auto-install-runner">
      {phase === 'installing' ? (
        <div className="flex items-center gap-2 text-xs text-warning" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          {t('ONBOARDING_INFERENCE_RUN_INSTALLING')}
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
          {t('ONBOARDING_INFERENCE_RUN_COMPLETE')}
        </span>
      )}
      {phase === 'error' && (
        <span className="flex items-center gap-1 text-xs text-destructive" role="alert">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {t('ONBOARDING_INFERENCE_RUN_ERROR')}
        </span>
      )}
    </div>
  );
};
