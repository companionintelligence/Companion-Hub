import { Button } from '@/components/ui/Button';
import { Check, Clock, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PoolHubCard, PoolStatusPill } from './pool-hub-card';
import { PoolSetupFooter } from './pool-setup-footer';
import type { PairRow, PairRowStatus } from './pool-setup-hooks';
import type { PairFailure } from './pool-setup-model';

const STATUS_KEYS: Record<PairRowStatus, string> = {
  queued: 'HUB_POOL_SETUP_ROW_QUEUED',
  sending: 'HUB_POOL_SETUP_ROW_SENDING',
  sent: 'HUB_POOL_SETUP_ROW_SENT',
  already: 'HUB_POOL_SETUP_ROW_ALREADY',
  failed: 'HUB_POOL_SETUP_ROW_FAILED',
};

const FAILURE_KEYS: Record<Exclude<PairFailure, 'already'>, string> = {
  unreachable: 'HUB_POOL_SETUP_FAIL_UNREACHABLE',
  invalid: 'HUB_POOL_SETUP_FAIL_INVALID',
  generic: 'HUB_POOL_SETUP_FAIL_GENERIC',
};

interface ConnectStepProps {
  rows: PairRow[];
  sending: boolean;
  demoMode: boolean;
  onBack: () => void;
  onContinue: () => void;
  onRetry: (row: PairRow) => void;
  onRetryFailed: () => void;
}

/**
 * Step 3: one request per selected Hub, sent together, each with its own result. A failure names what
 * the API lets the guide name and offers Retry for that row alone, so one unreachable Hub never makes
 * the user resend the requests that already worked.
 */
export function ConnectStep({ rows, sending, demoMode, onBack, onContinue, onRetry, onRetryFailed }: ConnectStepProps) {
  const { t } = useTranslation();
  const placed = rows.filter((row) => row.status === 'sent' || row.status === 'already').length;
  const anyFailed = rows.some((row) => row.status === 'failed');

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="pool-setup-step-connect">
      <div className="space-y-0.5">
        <h3 tabIndex={-1} data-step-heading className="text-base font-semibold outline-none">
          {t('HUB_POOL_SETUP_CONNECT_TITLE')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_CONNECT_INTRO')}</p>
      </div>

      <p role="status" className="text-sm font-medium" data-testid="pool-setup-connect-summary">
        {t('HUB_POOL_SETUP_CONNECT_SUMMARY', { sent: placed, count: rows.length })}
      </p>

      <ul aria-label={t('HUB_POOL_SETUP_CONNECT_LIST_LABEL')} className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <PoolHubCard
            key={row.nodeFqdn}
            data-testid={`pool-setup-row-${row.nodeFqdn}`}
            data-state={row.status}
            tone={row.status === 'failed' ? 'danger' : row.status === 'sent' || row.status === 'already' ? 'success' : 'default'}
            name={row.hostname}
            address={row.nodeFqdn}
            os={row.os}
            online={row.online}
            trailing={
              <PoolStatusPill
                tone={row.status === 'sent' || row.status === 'already' ? 'success' : row.status === 'failed' ? 'danger' : 'muted'}
                icon={row.status === 'failed' ? XCircle : row.status === 'queued' ? Clock : Check}
                spin={row.status === 'sending'}
              >
                {t(STATUS_KEYS[row.status])}
              </PoolStatusPill>
            }
          >
            {row.status === 'failed' && row.failure && row.failure !== 'already' ? (
              <div role="alert" className="space-y-2 text-xs text-destructive">
                <p>{t(FAILURE_KEYS[row.failure], { name: row.hostname })}</p>
                {row.usedPin ? <p>{t('HUB_POOL_SETUP_FAIL_PIN_HINT')}</p> : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={demoMode || sending}
                  aria-label={t('HUB_POOL_SETUP_ROW_RETRY_NAMED', { name: row.hostname })}
                  onClick={() => onRetry(row)}
                >
                  {t('COMMON_RETRY')}
                </Button>
              </div>
            ) : null}
          </PoolHubCard>
        ))}
      </ul>

      <PoolSetupFooter>
        <Button type="button" variant="ghost" disabled={sending} onClick={onBack}>
          {t('COMMON_BACK')}
        </Button>
        {anyFailed ? (
          <Button type="button" variant="outline" disabled={demoMode || sending} onClick={onRetryFailed}>
            {t('HUB_POOL_SETUP_CONNECT_RETRY_ALL')}
          </Button>
        ) : null}
        <Button type="button" disabled={sending || placed === 0} onClick={onContinue} data-testid="pool-setup-connect-continue">
          {t('COMMON_CONTINUE')}
        </Button>
      </PoolSetupFooter>
    </div>
  );
}
