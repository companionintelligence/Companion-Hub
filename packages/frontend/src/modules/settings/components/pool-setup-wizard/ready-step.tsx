import { Button } from '@/components/ui/Button';
import { openExternal } from '@/lib/helpers/open-external';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PoolSetupFooter } from './pool-setup-footer';
import {
  type Readiness,
  type ReadinessAction,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessState,
  TAILSCALE_DNS_ADMIN_URL,
} from './pool-setup-model';

const CHECK_LABEL_KEYS: Record<ReadinessCheckId, string> = {
  pooling: 'HUB_POOL_SETUP_CHECK_POOLING',
  tailscale: 'HUB_POOL_SETUP_CHECK_TAILSCALE',
  https: 'HUB_POOL_SETUP_CHECK_HTTPS',
  serve: 'HUB_POOL_SETUP_CHECK_SERVE',
  direction: 'HUB_POOL_SETUP_CHECK_DIRECTION',
};

const STATE_LABEL_KEYS: Record<ReadinessState | 'checking', string> = {
  ok: 'HUB_POOL_SETUP_STATUS_OK',
  warn: 'HUB_POOL_SETUP_STATUS_WARN',
  blocked: 'HUB_POOL_SETUP_STATUS_BLOCKED',
  checking: 'HUB_POOL_SETUP_STATUS_CHECKING',
};

const ACTION_LABEL_KEYS: Record<ReadinessAction, string> = {
  'turn-on-pooling': 'HUB_POOL_SETUP_POOLING_TURN_ON',
  'connect-tailscale': 'HUB_POOL_SETUP_TAILSCALE_CONNECT',
  'open-tailscale-dns': 'HUB_POOL_SETUP_HTTPS_OPEN_ADMIN',
};

interface ReadyStepProps {
  readiness: Readiness;
  /** The user pressed Connect Tailscale in this session, so the list is waiting on their browser tab. */
  signInStarted: boolean;
  signInPending: boolean;
  poolingPending: boolean;
  /** A Tailscale status read is in flight. */
  checking: boolean;
  demoMode: boolean;
  onTurnOnPooling: () => void;
  onConnectTailscale: () => void;
  onCheckAgain: () => void;
  onContinue: () => void;
}

/**
 * Step 1: is this Hub able to pair at all? Every row says what it is in words as well as an icon, so
 * colour is never the only signal. The list polls while this step is open (see `useTailscaleReadiness`),
 * which is how a row turns green after the user finishes signing in in their browser.
 */
export function ReadyStep({
  readiness,
  signInStarted,
  signInPending,
  poolingPending,
  checking,
  demoMode,
  onTurnOnPooling,
  onConnectTailscale,
  onCheckAgain,
  onContinue,
}: ReadyStepProps) {
  const { t } = useTranslation();

  const runAction = (action: ReadinessAction) => {
    if (action === 'turn-on-pooling') onTurnOnPooling();
    else if (action === 'connect-tailscale') onConnectTailscale();
    else void openExternal(TAILSCALE_DNS_ADMIN_URL);
  };

  const summaryKey =
    readiness.level === 'ok' ? 'HUB_POOL_SETUP_READY_OK' : readiness.level === 'warn' ? 'HUB_POOL_SETUP_READY_WARN' : 'HUB_POOL_SETUP_READY_BLOCKED';

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="pool-setup-step-ready">
      <div className="space-y-0.5">
        <h3 tabIndex={-1} data-step-heading className="text-base font-semibold outline-none">
          {t('HUB_POOL_SETUP_READY_TITLE')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_READY_INTRO')}</p>
      </div>

      <ul aria-label={t('HUB_POOL_SETUP_CHECKS_LABEL')} className="space-y-2">
        {readiness.checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            waitingForSignIn={signInStarted && check.id === 'tailscale' && check.state === 'blocked' && check.action === 'connect-tailscale'}
            actionLoading={(check.action === 'connect-tailscale' && signInPending) || (check.action === 'turn-on-pooling' && poolingPending)}
            demoMode={demoMode}
            onAction={runAction}
          />
        ))}
      </ul>

      <p role="status" className="text-sm text-muted-foreground" data-testid="pool-setup-ready-summary">
        {t(summaryKey)}
      </p>

      <PoolSetupFooter>
        <Button type="button" variant="outline" loading={checking} onClick={onCheckAgain}>
          {t('COMMON_CHECK_AGAIN')}
        </Button>
        <Button type="button" disabled={readiness.level === 'blocked'} onClick={onContinue} data-testid="pool-setup-ready-continue">
          {t(readiness.level === 'warn' ? 'HUB_POOL_SETUP_CONTINUE_ANYWAY' : 'COMMON_CONTINUE')}
        </Button>
      </PoolSetupFooter>
    </div>
  );
}

function CheckRow({
  check,
  waitingForSignIn,
  actionLoading,
  demoMode,
  onAction,
}: {
  check: ReadinessCheck;
  waitingForSignIn: boolean;
  actionLoading: boolean;
  demoMode: boolean;
  onAction: (action: ReadinessAction) => void;
}) {
  const { t } = useTranslation();
  const { action } = check;
  const display: ReadinessState | 'checking' = waitingForSignIn ? 'checking' : check.state;
  const Icon = display === 'ok' ? CheckCircle2 : display === 'warn' ? AlertTriangle : display === 'checking' ? Loader2 : XCircle;

  return (
    <li data-testid={`pool-setup-check-${check.id}`} data-state={check.state} className="flex items-start gap-3 rounded-md border px-3 py-2.5">
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          display === 'ok' && 'text-success',
          display === 'warn' && 'text-warning',
          display === 'blocked' && 'text-destructive',
          display === 'checking' && 'animate-spin text-muted-foreground',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{t(CHECK_LABEL_KEYS[check.id])}</span>
          <span className="text-xs text-muted-foreground">{t(STATE_LABEL_KEYS[display])}</span>
        </div>
        {check.detailKey ? <p className="break-words text-xs text-muted-foreground">{t(check.detailKey, check.detailParams)}</p> : null}
        {waitingForSignIn ? <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_TAILSCALE_WAITING')}</p> : null}
        {check.remedy ? (
          <code
            data-testid="pool-setup-serve-remedy"
            className="block select-all whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs"
          >
            {check.remedy}
          </code>
        ) : null}
        {action ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={demoMode && action !== 'open-tailscale-dns'}
            loading={actionLoading}
            onClick={() => onAction(action)}
          >
            {t(ACTION_LABEL_KEYS[action])}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
