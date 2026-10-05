import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { AlertTriangle, Check, CheckCircle2, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type PoolPeer, type PoolStatus, peerLabel } from '../../helpers/hub-pool-shared';
import { PoolHubCard, PoolStatusPill } from './pool-hub-card';
import { PoolSetupFooter } from './pool-setup-footer';
import type { PairRow } from './pool-setup-hooks';
import { type PeerProgress, canUnpair, countPoolModels, normalizeNodeName, peerEngines, peerModelCount, peerProgress } from './pool-setup-model';

interface ApproveStepProps {
  pool: PoolStatus;
  /** How many times pool status has been fetched. A request is only called gone by a fetch after the send settled. */
  dataUpdateCount: number;
  /** Requests this session sent and that did not fail. */
  sentRows: PairRow[];
  /** Requests the user cancelled in this session, whose disappearance is expected. */
  cancelled: string[];
  settledAfterUpdate: number | null;
  longWait: boolean;
  expired: boolean;
  demoMode: boolean;
  approvingId: string | null;
  rejectingId: string | null;
  cancellingId: string | null;
  unpairingId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCancel: (peer: PoolPeer) => void;
  onUnpair: (peer: PoolPeer) => void;
  onCheckAgain: () => void;
  onFind: () => void;
  onPairAgain: (row: PairRow) => void;
  onDone: () => void;
}

const SETTLED_PROGRESS: PeerProgress[] = ['verifying', 'verified', 'disabled', 'unreachable', 'needs_repair', 'needs_credentials', 'half_paired'];
/** Rows a screen reader user should hear about when they appear: everything that is not working and is not a deliberate switch-off. */
const ATTENTION_PROGRESS: PeerProgress[] = ['unreachable', 'needs_repair', 'needs_credentials', 'half_paired'];

/**
 * Step 4, and the step a reopened guide lands on: everything here is read from pool status, so it is
 * right whether the user just sent a request, reopened the guide an hour later, or is on the Hub that
 * RECEIVED a request and has never seen steps 1 to 3.
 *
 * Pairing is one-sided. The Hub that sends a request waits; an operator on the other Hub approves it.
 * Nothing is pooled until then, so the copy says whose move it is.
 */
export function ApproveStep({
  pool,
  dataUpdateCount,
  sentRows,
  cancelled,
  settledAfterUpdate,
  longWait,
  expired,
  demoMode,
  approvingId,
  rejectingId,
  cancellingId,
  unpairingId,
  onApprove,
  onReject,
  onCancel,
  onUnpair,
  onCheckAgain,
  onFind,
  onPairAgain,
  onDone,
}: ApproveStepProps) {
  const { t } = useTranslation();

  const rows = pool.peers.map((peer) => ({ peer, progress: peerProgress(peer) }));
  const waiting = rows.filter((row) => row.progress === 'waiting');
  const incoming = rows.filter((row) => row.progress === 'incoming');
  const connected = rows.filter((row) => SETTLED_PROGRESS.includes(row.progress));
  const verified = rows.filter((row) => row.progress === 'verified');
  const attention = rows.filter((row) => ATTENTION_PROGRESS.includes(row.progress));

  // Called gone only from a status fetched after the send settled: one fetched before it simply has not
  // seen the new row yet, and would claim every request vanished the moment it was made.
  const known = new Set(pool.peers.map((peer) => normalizeNodeName(peer.nodeFqdn)));
  const cancelledHere = new Set(cancelled.map(normalizeNodeName));
  const vanished =
    settledAfterUpdate !== null && dataUpdateCount > settledAfterUpdate
      ? sentRows.filter((row) => !known.has(normalizeNodeName(row.nodeFqdn)) && !cancelledHere.has(normalizeNodeName(row.nodeFqdn)))
      : [];

  const localFingerprint = pool.localNode.identity?.publicKeyFingerprint;
  const empty = pool.peers.length === 0 && vanished.length === 0;

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="pool-setup-step-approve">
      <div className="space-y-0.5">
        <h3 tabIndex={-1} data-step-heading className="text-base font-semibold outline-none">
          {t('HUB_POOL_SETUP_APPROVE_TITLE')}
        </h3>
        {waiting.length > 0 || vanished.length > 0 ? <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_APPROVE_EXPLAIN')}</p> : null}
      </div>

      {/* Persistent, so a screen reader hears the pool become ready or a Hub fall over; a region that appears with its text is often missed. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="pool-setup-announce">
        {[
          verified.length > 0 ? t('HUB_POOL_SETUP_SUCCESS_TITLE') : '',
          attention.length > 0 ? t('HUB_POOL_SETUP_ANNOUNCE_ATTENTION', { count: attention.length }) : '',
        ]
          .filter(Boolean)
          .join(' ')}
      </div>

      {verified.length > 0 ? (
        <section data-testid="pool-setup-success" className="space-y-3 rounded-lg border border-success/30 bg-success/10 p-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="min-w-0 space-y-0.5">
              <h4 className="text-sm font-semibold text-success">{t('HUB_POOL_SETUP_SUCCESS_TITLE')}</h4>
              {/* Said only when this Hub sends work to its peers. With outbound switched off the user chose to continue past
                  that warning, and "apps now route across the pool" would be false for them. */}
              <p className="text-xs text-muted-foreground">
                {pool.directions.outbound.enabled ? t('HUB_POOL_SETUP_SUCCESS_BODY') : t('HUB_POOL_SETUP_DIRECTION_OFF')}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-background/60 px-3 py-2">
              <dt className="text-muted-foreground">{t('HUB_POOL_SETUP_SUCCESS_HUBS')}</dt>
              <dd className="text-xl font-semibold leading-tight" data-testid="pool-setup-success-hubs">
                {verified.length}
              </dd>
            </div>
            <div className="rounded-md bg-background/60 px-3 py-2">
              <dt className="text-muted-foreground">{t('HUB_POOL_SETUP_SUCCESS_MODELS')}</dt>
              <dd className="text-xl font-semibold leading-tight" data-testid="pool-setup-success-models">
                {countPoolModels(pool)}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {vanished.map((row) => (
        <div
          key={row.nodeFqdn}
          role="alert"
          data-testid="pool-setup-vanished"
          className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{t('HUB_POOL_SETUP_VANISHED', { name: row.hostname })}</p>
          <Button type="button" size="sm" variant="outline" className="shrink-0 self-start" disabled={demoMode} onClick={() => onPairAgain(row)}>
            {t('HUB_POOL_SETUP_PAIR_AGAIN')}
          </Button>
        </div>
      ))}

      {expired ? (
        <div
          data-testid="pool-setup-poll-stopped"
          className="flex flex-col gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{t('HUB_POOL_SETUP_POLL_STOPPED')}</p>
          <Button type="button" size="sm" variant="outline" className="shrink-0 self-start" onClick={onCheckAgain}>
            {t('COMMON_CHECK_AGAIN')}
          </Button>
        </div>
      ) : null}

      {incoming.length > 0 ? (
        <Group title={t('HUB_POOL_SETUP_INBOUND_TITLE')} testId="pool-setup-incoming">
          <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_INBOUND_HELP')}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {incoming.map(({ peer }) => {
              const nameId = `pool-setup-incoming-${peer.id}-name`;
              return (
                <PoolHubCard
                  key={peer.id}
                  data-testid={`pool-setup-incoming-${peer.id}`}
                  tone="warning"
                  /* The tailnet name, not the display name: approving issues a token to this exact host, and the
                     display name is whatever the unauthenticated requester chose to call itself. */
                  name={peer.nodeFqdn.split('.')[0] ?? peer.nodeFqdn}
                  address={peer.nodeFqdn}
                  wrapAddress
                  trailing={<PoolStatusPill tone="warning">{t('HUB_POOL_SETUP_STATUS_INCOMING')}</PoolStatusPill>}
                >
                  <span id={nameId} className="sr-only">
                    {peer.nodeFqdn}
                  </span>
                  {/* The safety-relevant line. A key is something to compare; its absence is something to be warned about, in words. */}
                  {peer.peerKeyFingerprint ? (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="pool-setup-incoming-fingerprint">
                      <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {t('HUB_POOL_PEER_FINGERPRINT', { fingerprint: breakAtColons(peer.peerKeyFingerprint) })}
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5 text-xs text-warning" data-testid="pool-setup-incoming-unverified">
                      <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0">{t('HUB_POOL_PEER_FINGERPRINT_UNVERIFIED')}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={demoMode}
                      loading={approvingId === peer.id}
                      aria-describedby={nameId}
                      onClick={() => onApprove(peer.id)}
                    >
                      {t('HUB_POOL_APPROVE_BUTTON')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={demoMode}
                      loading={rejectingId === peer.id}
                      aria-describedby={nameId}
                      onClick={() => onReject(peer.id)}
                    >
                      {t('HUB_POOL_REJECT_BUTTON')}
                    </Button>
                  </div>
                </PoolHubCard>
              );
            })}
          </ul>
          {localFingerprint ? (
            <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="pool-setup-local-fingerprint">
              {t('HUB_POOL_LOCAL_FINGERPRINT', { fingerprint: breakAtColons(localFingerprint) })}
            </p>
          ) : null}
        </Group>
      ) : null}

      {waiting.length > 0 ? (
        <Group title={t('HUB_POOL_SETUP_WAITING_TITLE')} testId="pool-setup-waiting">
          <ul className="grid gap-2 sm:grid-cols-2">
            {waiting.map(({ peer }) => {
              const nameId = `pool-setup-waiting-${peer.id}-name`;
              return (
                <PoolHubCard
                  key={peer.id}
                  data-testid={`pool-setup-waiting-${peer.id}`}
                  name={hubTitle(peer)}
                  address={peer.nodeFqdn}
                  trailing={
                    <PoolStatusPill tone="muted" spin>
                      {t('HUB_POOL_SETUP_STATUS_WAITING')}
                    </PoolStatusPill>
                  }
                >
                  {/* The sentence is for assistive technology: the pill says "awaiting approval" and the card names the Hub. */}
                  <span id={nameId} className="sr-only">
                    {t('HUB_POOL_OUTBOUND_WAITING', { name: peerLabel(peer) })}
                  </span>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="-mr-2 -mb-1 shrink-0"
                      disabled={demoMode}
                      loading={cancellingId === peer.id}
                      aria-describedby={nameId}
                      onClick={() => onCancel(peer)}
                    >
                      {t('HUB_POOL_CANCEL_REQUEST_BUTTON')}
                    </Button>
                  </div>
                  {longWait ? (
                    <p className="text-xs text-muted-foreground" data-testid="pool-setup-waiting-long">
                      {t('HUB_POOL_SETUP_WAITING_LONG', { name: peerLabel(peer) })}
                    </p>
                  ) : null}
                </PoolHubCard>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_CANCEL_NOTE')}</p>
        </Group>
      ) : null}

      {connected.length > 0 ? (
        <Group title={t('HUB_POOL_SETUP_CONNECTED_TITLE')} testId="pool-setup-connected">
          <ul className="grid gap-2 sm:grid-cols-2">
            {connected.map(({ peer, progress }) => {
              const nameId = `pool-setup-connected-${peer.id}-name`;
              const known = progress === 'verified';
              return (
                <PoolHubCard
                  key={peer.id}
                  data-testid={`pool-setup-connected-${peer.id}`}
                  data-state={progress}
                  tone={known ? 'success' : canUnpair(progress) ? 'danger' : 'default'}
                  name={hubTitle(peer)}
                  address={peer.nodeFqdn}
                  /* A Hub's own report: tier, engines, models and load are shown only once it has been read, never guessed. */
                  tier={known ? peer.lastCapabilities?.hardwareTier : null}
                  engines={known ? peerEngines(peer) : undefined}
                  models={known ? peerModelCount(peer) : null}
                  running={known ? peer.inFlightRequests : null}
                  identity={peer.authMode === 'signed' ? 'signed' : peer.authMode === 'bearer' ? 'token' : null}
                  trailing={statusPill(progress, t)}
                >
                  <span id={nameId} className="sr-only">
                    {peerLabel(peer)}
                  </span>
                  <ProgressLine peer={peer} progress={progress} />
                  {/* The guide's own way out of a state waiting never clears. Without it the row would name the fix and offer no button for it. */}
                  {canUnpair(progress) ? (
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={demoMode}
                        loading={unpairingId === peer.id}
                        aria-describedby={nameId}
                        onClick={() => onUnpair(peer)}
                      >
                        {t('HUB_POOL_UNPAIR_BUTTON')}
                      </Button>
                    </div>
                  ) : null}
                </PoolHubCard>
              );
            })}
          </ul>
        </Group>
      ) : null}

      {empty ? (
        <div className="space-y-2" data-testid="pool-setup-approve-empty">
          <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_APPROVE_EMPTY')}</p>
          <Button type="button" size="sm" variant="outline" onClick={onFind}>
            {t('HUB_POOL_SETUP_APPROVE_FIND')}
          </Button>
        </div>
      ) : null}

      <PoolSetupFooter>
        {empty ? null : (
          <Button type="button" variant="outline" onClick={onFind}>
            {t('HUB_POOL_SETUP_SUCCESS_ADD')}
          </Button>
        )}
        <Button type="button" variant={empty ? 'outline' : 'default'} onClick={onDone}>
          {t('HUB_POOL_SETUP_DONE_BUTTON')}
        </Button>
      </PoolSetupFooter>
    </div>
  );
}

function Group({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** A Hub's title: the name it was given, else the host part of its tailnet name. The full tailnet name is shown under it either way. */
const hubTitle = (peer: PoolPeer) => peer.displayName || peer.nodeFqdn.split('.')[0] || peer.nodeFqdn;

/** A fingerprint is colon-separated hex; a zero-width space after each colon lets it wrap there instead of splitting a byte pair. */
const breakAtColons = (fingerprint: string) => fingerprint.replace(/:/g, ':\u200b');

/** The header pill of a connected card: working, still reading, or needing a look. Words first, colour second. */
function statusPill(progress: PeerProgress, t: (key: string) => string) {
  if (progress === 'verified')
    return (
      <PoolStatusPill tone="success" icon={Check}>
        {t('HUB_POOL_SETUP_STATUS_VERIFIED')}
      </PoolStatusPill>
    );
  if (progress === 'verifying')
    return (
      <PoolStatusPill tone="muted" spin>
        {t('HUB_POOL_SETUP_STATUS_READING')}
      </PoolStatusPill>
    );
  if (progress === 'disabled') return <PoolStatusPill tone="muted">{t('HUB_POOL_SETUP_STATUS_OFF')}</PoolStatusPill>;
  return (
    <PoolStatusPill tone="danger" icon={AlertTriangle}>
      {t('HUB_POOL_SETUP_STATUS_ATTENTION')}
    </PoolStatusPill>
  );
}

/** What a settled row says. Every state is text, with an icon only as an extra, never the sole signal. */
function ProgressLine({ peer, progress }: { peer: PoolPeer; progress: PeerProgress }) {
  const { t } = useTranslation();
  const name = peerLabel(peer);

  // Verified and verifying are said by the pill in the card's header; only a problem needs a sentence.
  if (progress === 'verifying' || progress === 'verified') return null;

  const text =
    progress === 'disabled'
      ? t('HUB_POOL_SETUP_PEER_DISABLED')
      : progress === 'needs_repair'
        ? t('HUB_POOL_SETUP_NEEDS_REPAIR', { name })
        : progress === 'needs_credentials'
          ? t('HUB_POOL_SETUP_NEEDS_CREDENTIALS', { name })
          : progress === 'half_paired'
            ? t('HUB_POOL_SETUP_HALF_PAIRED', { name })
            : t('HUB_POOL_SETUP_UNREACHABLE');

  return (
    <span className={cn('flex items-start gap-1.5 text-xs', canUnpair(progress) ? 'text-destructive' : 'text-muted-foreground')}>
      {progress === 'disabled' ? null : <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />}
      <span>{text}</span>
    </span>
  );
}
