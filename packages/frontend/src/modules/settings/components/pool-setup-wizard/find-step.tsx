import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolStatus } from '../../helpers/hub-pool-shared';
import { PoolHubSummary } from './pool-hub-card';
import { PoolSetupFooter } from './pool-setup-footer';
import { type PairTarget, useDiscoveryScan } from './pool-setup-hooks';
import {
  PAIR_BY_ADDRESS_COMMAND,
  type Readiness,
  type TailscaleSetupStatus,
  normalizeNodeName,
  selectPairable,
  unansweredTailnetDevices,
} from './pool-setup-model';

const PIN_LENGTH = 6;
const DOCS_URL = 'https://docs.ci.computer';

interface FindStepProps {
  pool: PoolStatus;
  ts: TailscaleSetupStatus | undefined;
  /** `undefined` while Tailscale's status is still loading: an unknown is not a reason to say the Hub is not ready. */
  readiness: Readiness | undefined;
  demoMode: boolean;
  onBack: () => void;
  onSend: (targets: PairTarget[], pin?: string) => void;
  onReview: () => void;
  onCheckReadiness: () => void;
}

/**
 * Step 2: scan the tailnet once, then pick the Hubs to send requests to.
 *
 * The scan runs when this step mounts and when the user presses Rescan, never on a timer: the route
 * contacts every unpaired tailnet device, so a poll would turn an idle dialog into constant network
 * traffic across the user's whole tailnet.
 *
 * Nothing is selected until the user chooses. A pairing request is an introduction made on the user's
 * behalf to another machine, and a tailnet can hold Hubs that belong to someone else or that the user
 * deliberately keeps apart, so "send to everything found" must be a decision, never a default.
 */
export function FindStep({ pool, ts, readiness, demoMode, onBack, onSend, onReview, onCheckReadiness }: FindStepProps) {
  const { t } = useTranslation();
  const scan = useDiscoveryScan();
  const { mutate: runScan } = scan;

  // A ref, not state: under StrictMode the effect body runs twice and a second scan would double the probing.
  const scanned = useRef(false);
  useEffect(() => {
    if (scanned.current) return;
    scanned.current = true;
    runScan();
  }, [runScan]);

  // The set the user turned ON. A rescan keeps the choices that are still on the list; a newly found Hub arrives unchosen.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // The PIN is remembered with the Hub it was typed for. Digits minted on one Hub are not carried over when the
  // selection moves to another: that Hub would refuse them, and a refused PIN counts against its attempt limit.
  const [pinEntry, setPinEntry] = useState<{ nodeFqdn: string; digits: string } | null>(null);
  const [pinTouched, setPinTouched] = useState(false);

  const existing = new Set(pool.peers.map((peer) => normalizeNodeName(peer.nodeFqdn)));
  const found = scan.data ? selectPairable(scan.data) : undefined;
  // The server already hides Hubs that have a row; this is the same rule again, for a list that is a few seconds old.
  // Sorted so the list does not reshuffle between scans: the order the probes happened to answer in means nothing.
  const pairable = (found?.pairable ?? [])
    .filter((device) => !existing.has(normalizeNodeName(device.nodeFqdn)))
    .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.nodeFqdn.localeCompare(b.nodeFqdn));
  const selected = pairable.filter((device) => chosen.has(device.nodeFqdn));
  const allSelected = pairable.length > 0 && selected.length === pairable.length;

  const scanning = scan.isPending || (!scan.isError && !scan.data);
  const scanFinished = Boolean(scan.data) && !scan.isPending;

  // A PIN names one Hub's pairing and is single use, so it only applies when exactly one Hub is selected.
  const pinUsable = selected.length === 1;
  const pin = pinUsable && pinEntry && pinEntry.nodeFqdn === selected[0]?.nodeFqdn ? pinEntry.digits : '';
  const partialPin = pinUsable && pin.length > 0 && pin.length < PIN_LENGTH;
  const pinToSend = pinUsable && pin.length === PIN_LENGTH ? pin : undefined;

  const toggle = (nodeFqdn: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(nodeFqdn);
      else next.delete(nodeFqdn);
      return next;
    });

  const toggleAll = (on: boolean) => setChosen(on ? new Set(pairable.map((device) => device.nodeFqdn)) : new Set());

  const send = () => {
    onSend(
      selected.map((device) => ({ nodeFqdn: device.nodeFqdn, hostname: device.hostname, os: device.os, online: device.online })),
      pinToSend,
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="pool-setup-step-find">
      <div className="space-y-0.5">
        <h3 tabIndex={-1} data-step-heading className="text-base font-semibold outline-none">
          {t('HUB_POOL_SETUP_FIND_TITLE')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_FIND_INTRO')}</p>
      </div>

      {readiness?.level === 'blocked' ? (
        <div
          data-testid="pool-setup-find-not-ready"
          className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{t('HUB_POOL_SETUP_FIND_NEEDS_READY')}</p>
          <Button type="button" size="sm" variant="outline" className="shrink-0 self-start" onClick={onCheckReadiness}>
            {t('HUB_POOL_SETUP_STEP_READY')}
          </Button>
        </div>
      ) : null}

      {/* Always mounted, with its text changing underneath it. A live region that appears already holding its text is
          often missed by a screen reader, and this is the one place where "nothing happened" and "nothing was found" must sound different. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="pool-setup-find-announce">
        {scanning
          ? t('HUB_POOL_SETUP_FIND_SCANNING')
          : scanFinished
            ? pairable.length > 0
              ? t('HUB_POOL_SETUP_FIND_RESULT', { count: pairable.length })
              : t('HUB_POOL_SETUP_EMPTY_TITLE')
            : ''}
      </div>

      {scanning ? (
        <div data-testid="pool-setup-scanning" aria-hidden="true" className="grid gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex animate-pulse gap-3 rounded-lg border p-3">
              <span className="size-9 shrink-0 rounded-md bg-muted" />
              <span className="flex flex-1 flex-col gap-2">
                <span className="h-3.5 w-1/2 rounded bg-muted" />
                <span className="h-3 w-4/5 rounded bg-muted" />
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {scan.isError ? (
        <p
          role="alert"
          data-testid="pool-setup-scan-error"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          {t('HUB_POOL_SETUP_FIND_ERROR')}
        </p>
      ) : null}

      {scanFinished && pairable.length > 0 ? (
        <div className="space-y-3">
          <fieldset className="space-y-2.5">
            <legend className="sr-only">{t('HUB_POOL_SETUP_FIND_LEGEND')}</legend>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium" data-testid="pool-setup-found">
                {t('HUB_POOL_SETUP_FIND_RESULT', { count: pairable.length })}
              </p>
              <Checkbox
                name="pool-setup-select-all"
                checked={allSelected}
                onCheckedChange={(checked) => toggleAll(checked === true)}
                label={t('HUB_POOL_SETUP_FIND_SELECT_ALL')}
                className="shrink-0 cursor-pointer text-sm [&>input]:size-4"
              />
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {pairable.map((device) => {
                const isChosen = chosen.has(device.nodeFqdn);
                return (
                  <li key={device.nodeFqdn} className="min-w-0">
                    <Checkbox
                      name={`pool-setup-hub-${device.nodeFqdn}`}
                      className={cn(
                        'h-full cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                        isChosen && 'border-primary/60 bg-primary/5 ring-1 ring-primary/30',
                        '[&>input]:mt-2 [&>input]:size-5 [&>span]:min-w-0 [&>span]:flex-1',
                      )}
                      checked={isChosen}
                      onCheckedChange={(checked) => toggle(device.nodeFqdn, checked === true)}
                      label={<PoolHubSummary name={device.hostname} address={device.nodeFqdn} os={device.os} online={device.online} />}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t('HUB_POOL_SETUP_FIND_SELECTED', { selected: selected.length, total: pairable.length })}
            </p>
          </fieldset>

          <details className="rounded-lg border px-3 py-2" data-testid="pool-setup-pin">
            <summary className="cursor-pointer py-1 text-sm font-medium">{t('HUB_POOL_SETUP_PIN_SUMMARY')}</summary>
            <div className="mt-2 space-y-2 pb-1">
              <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_PIN_HELP')}</p>
              <Input
                name="pool-setup-pin-input"
                value={pin}
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_LENGTH}
                disabled={!pinUsable || demoMode}
                label={t('HUB_POOL_PIN_INPUT_LABEL')}
                error={partialPin && pinTouched ? t('HUB_POOL_PIN_INPUT_INVALID') : undefined}
                onChange={(event) => {
                  const only = selected[0];
                  if (only && selected.length === 1)
                    setPinEntry({ nodeFqdn: only.nodeFqdn, digits: event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH) });
                }}
                onBlur={() => setPinTouched(true)}
              />
              {pinUsable ? null : <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_PIN_ONE_AT_A_TIME')}</p>}
            </div>
          </details>
        </div>
      ) : null}

      {scanFinished && pairable.length === 0 ? <EmptyState pool={pool} ts={ts} /> : null}

      {scanFinished && found && found.unverifiedCount > 0 ? (
        <p data-testid="pool-setup-unverified" className="text-xs text-muted-foreground">
          {t('HUB_POOL_SETUP_FIND_UNVERIFIED', { count: found.unverifiedCount })}
        </p>
      ) : null}

      {pool.peers.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="pool-setup-in-progress">
          <span>{t('HUB_POOL_SETUP_FIND_IN_PROGRESS', { count: pool.peers.length })}</span>
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onReview}>
            {t('HUB_POOL_SETUP_FIND_REVIEW')}
          </Button>
        </p>
      ) : null}

      <PoolSetupFooter>
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('COMMON_BACK')}
        </Button>
        <Button type="button" variant="outline" disabled={scanning} onClick={() => runScan()} data-testid="pool-setup-rescan">
          {t('HUB_POOL_SETUP_FIND_RESCAN')}
        </Button>
        {/* Nothing to send until a scan finds a Hub; a disabled "Send 0 requests" beside an empty result only confuses. */}
        {pairable.length > 0 ? (
          <Button type="button" disabled={demoMode || scanning || selected.length === 0 || partialPin} onClick={send} data-testid="pool-setup-send">
            {selected.length === 0 ? t('HUB_POOL_SETUP_FIND_PICK') : t('HUB_POOL_SETUP_FIND_SEND', { count: selected.length })}
          </Button>
        ) : null}
      </PoolSetupFooter>
    </div>
  );
}

/**
 * Nothing answered. An empty list is not an error: the endpoint returns the same `[]` when Tailscale is
 * off, when nothing answered and when the peers have no HTTPS, so this lists every cause the user can
 * act on, shows what the tailnet itself lists, and gives the address-and-PIN route for a Hub the
 * directory cannot name.
 */
function EmptyState({ pool, ts }: { pool: PoolStatus; ts: TailscaleSetupStatus | undefined }) {
  const { t } = useTranslation();
  const devices = ts ? unansweredTailnetDevices({ ts, pool }) : undefined;

  return (
    <section data-testid="pool-setup-empty" className="space-y-3 rounded-lg border px-3 py-3">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{t('HUB_POOL_SETUP_EMPTY_TITLE')}</h4>
        <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_INTRO')}</p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t('HUB_POOL_SETUP_EMPTY_CAUSE_INSTALL')}</li>
        <li>{t('HUB_POOL_SETUP_EMPTY_CAUSE_TAILNET')}</li>
        <li>{t('HUB_POOL_SETUP_EMPTY_CAUSE_HTTPS')}</li>
      </ul>

      {devices ? (
        <div className="space-y-1" data-testid="pool-setup-empty-devices">
          {devices.total === 0 ? (
            <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_NONE_SEEN')}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_SEEN', { count: devices.total })}</p>
              <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs text-muted-foreground">
                {devices.shown.map((device) => (
                  <li key={device.nodeFqdn} className="break-all">
                    {device.online ? device.name : t('HUB_POOL_SETUP_DEVICE_OFFLINE', { name: device.name })}
                  </li>
                ))}
              </ul>
              {devices.more > 0 ? <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_MORE', { more: devices.more })}</p> : null}
            </>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_DOCTOR')}</p>
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-primary underline-offset-2 hover:underline">
        {t('HUB_POOL_SETUP_EMPTY_INSTALL_LINK')}
      </a>

      <div className="space-y-1.5 border-t pt-3">
        <h4 className="text-sm font-semibold">{t('HUB_POOL_SETUP_EMPTY_ADDRESS_TITLE')}</h4>
        <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_EMPTY_ADDRESS_BODY')}</p>
        <code
          data-testid="pool-setup-pair-command"
          className="block select-all whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs"
        >
          {PAIR_BY_ADDRESS_COMMAND}
        </code>
      </div>
    </section>
  );
}
