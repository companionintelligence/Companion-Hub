import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { QrCode } from '@/components/ui/qr-code';
import { AlertCircle, CheckCircle2, ChevronRight, Copy, Loader2, QrCode as QrCodeIcon } from 'lucide-react';
import {
  fetchDeviceRegistrationInfoResult,
  fetchRegistrationStateDrift,
  fetchRegistrationStatusResult,
  markRegistrationRestoreIntentDetailed,
  pairWithCode,
  prepareFreshRegistrationDetailed,
  probeRegistrationDomain,
} from '@/lib/registration-api';
import type { RegistrationStatus } from '@/lib/registration-status';
import { isRegistrationOperational, isRegistrationPending, requiresDeviceRegistration, requiresPortalRePairing } from '@/lib/registration-status';
import { cacheRegistrationStatus, clearRegistrationCache } from '@/lib/registration-cache';
import toast from 'react-hot-toast';
import { HintText, LabelWithHint } from '@/components/ui/field-hint/field-hint';
import {
  REGISTRATION_ACCOUNT_HINT,
  REGISTRATION_DEVICE_ID_HINT,
  REGISTRATION_DNS_HINT,
  REGISTRATION_PAIRING_CODE_HINT,
  REGISTRATION_PROVISIONING_HINT,
} from '@/components/hub-status/hub-status-tooltips';
import { normalizePairingCode, resolvePendingPairingCode, stashPendingPairingCode } from '@/lib/deep-link-pair';
import { captureHubWarning, setHubSentryDeviceId } from '@/lib/sentry';
import { getStoredDriftChoice, storeDriftChoice, type RegistrationStateDrift } from '@/lib/registration-state-drift';
import { RegistrationRestoreBanner, RegistrationStateDriftDialog } from '@/modules/auth/components/registration-state-drift-dialog';
import { useTranslation } from 'react-i18next';

const DEFAULT_PORTAL_URL = (
  (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim() ||
  (import.meta.env.CI_HUB_ENVIRONMENT === 'production' ? 'https://hub.ci.computer' : 'https://hub.companionintelligence.com')
).replace(/\/+$/, '');
const STATUS_POLL_INTERVAL_MS = 3000;
const HEADLESS_POLL_INTERVAL_MS = 5000; // slower poll when idle, waiting for external registration
const DOMAIN_PROBE_INTERVAL_MS = 5000;
const MAX_DOMAIN_PROBE_ATTEMPTS = 60;
const REQUIRED_CONSECUTIVE_PROBES = 2;

function buildPortalPairingRedirectPath(deviceId: string | null): string {
  const params = new URLSearchParams({ add_device: '1' });
  if (deviceId) {
    params.set('hub_device_id', deviceId);
  }
  return `/home?${params.toString()}`;
}

function buildPortalSignupUrl(portalBaseUrl: string, deviceId: string | null): string {
  const redirect = buildPortalPairingRedirectPath(deviceId);
  return `${portalBaseUrl.replace(/\/+$/, '')}/signup?redirect=${encodeURIComponent(redirect)}`;
}

type PairingTarget = {
  domain?: string;
  subdomain?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Headless appliances (and SSH sessions) have no browser for the Sign in /
 * Create account links. Keep the QR + fallback URL off the default two-column
 * layout — those plates were stretching Step 1 while Step 2 sat empty — and
 * reveal them from a "Scan QR" disclosure instead.
 */
function ScanQrDisclosure({ value, label, summaryLabel }: { value: string; label: string; summaryLabel: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={summaryLabel}
        onClick={() => setOpen((current) => !current)}
        className="flex h-10 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border/70 bg-background/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:h-11"
      >
        <QrCodeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {label}
      </button>
      {open ? (
        <div className="mt-4 flex w-full justify-center">
          {/*
            No `mark`: these URLs are long enough that level `H` plus the logo
            pushes the version up, and this is the one screen where a failed scan
            leaves the user with no way forward. Size is pinned at 200px so the
            module pitch is scannable (160px gave ~3px/module on the signup URL).
          */}
          <QrCode value={value} fallback={value} size={200} bare />
        </div>
      ) : null}
    </>
  );
}

function getProgressCopy(status: RegistrationStatus | null, redirectStatus: string, t: (key: string) => string) {
  if (!status) {
    return {
      title: t('DEVICE_REGISTRATION_CHECKING_STATUS'),
      description: t('DEVICE_REGISTRATION_PLEASE_WAIT'),
      hint: undefined as string | undefined,
    };
  }

  switch (status.phase) {
    case 'paired':
      return {
        title: t('DEVICE_REGISTRATION_PROVISIONING_YOUR_DOMAIN'),
        description: t('DEVICE_REGISTRATION_PROVISIONING_YOUR_DOMAIN_DESC'),
        hint: t(REGISTRATION_PROVISIONING_HINT),
      };
    case 'provisioning':
      return {
        title: t('DEVICE_REGISTRATION_SETTING_UP_HUB'),
        description: t('DEVICE_REGISTRATION_SETTING_UP_HUB_DESC'),
        hint: t(REGISTRATION_DNS_HINT),
      };
    case 'degraded':
      return {
        title: t('DEVICE_REGISTRATION_HUB_SETUP_NEEDS_ATTENTION'),
        description: redirectStatus,
        hint: undefined,
      };
    default:
      return {
        title: t('DEVICE_REGISTRATION_COMPLETE'),
        description: redirectStatus,
        hint: undefined,
      };
  }
}

export default function DeviceRegistrationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [portalBaseUrl, setPortalBaseUrl] = useState<string>(DEFAULT_PORTAL_URL);
  const [registrationUrl, setRegistrationUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deviceInfoError, setDeviceInfoError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatus | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [redirectStatusKey, setRedirectStatusKey] = useState('DEVICE_REGISTRATION_SETTING_UP_HUB_ELLIPSIS');

  const pairingInputRef = useRef<HTMLInputElement>(null);
  const pendingPairTargetRef = useRef<PairingTarget | null>(null);
  const pairingInProgressRef = useRef(false);
  const completionStartedRef = useRef(false);
  const lastStatusFetchSucceededRef = useRef(false);
  const deepLinkPairAttemptRef = useRef<string | null>(null);
  const [pendingDeepLinkCode, setPendingDeepLinkCode] = useState<string | null>(null);
  const [stateDrift, setStateDrift] = useState<RegistrationStateDrift | null>(null);
  const [driftDialogOpen, setDriftDialogOpen] = useState(false);
  const [driftChoice, setDriftChoice] = useState<'fresh' | 'restore' | null>(() => getStoredDriftChoice());
  const [isPreparingFresh, setIsPreparingFresh] = useState(false);
  const isTauri = '__TAURI_INTERNALS__' in window;
  const canAutoPairFromDeepLink = isTauri && !isLoading && (!registrationStatus || requiresDeviceRegistration(registrationStatus));

  const loadDeviceInfo = useCallback(async () => {
    try {
      const deviceResult = await fetchDeviceRegistrationInfoResult();
      if (!deviceResult.ok) {
        captureHubWarning(
          'Device registration page could not load device info',
          {
            status: deviceResult.status,
          },
          { dedupeKey: `device-registration-device-info:${deviceResult.status}` },
        );
        setDeviceInfoError(t('DEVICE_REGISTRATION_DEVICE_INFO_FAILED'));
        return;
      }

      const deviceData = (deviceResult.data ?? {}) as {
        device_id?: string;
        ci_cloud_url?: string;
        registration_url?: string | null;
      };
      setDeviceId(deviceData.device_id ?? null);
      setHubSentryDeviceId(deviceData.device_id);
      const base = deviceData.ci_cloud_url?.trim();
      if (base) {
        setPortalBaseUrl(base.replace(/\/+$/, ''));
      }
      // Portal entry URL (device_id + callback_url) opens login/signup and the Add Device flow.
      setRegistrationUrl(deviceData.registration_url?.trim() || null);
      setDeviceInfoError(null);
    } catch (error) {
      console.error(error);
      captureHubWarning(
        'Device registration page could not load device info',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { dedupeKey: 'device-registration-device-info:exception' },
      );
      setDeviceInfoError(t('DEVICE_REGISTRATION_DEVICE_INFO_FAILED'));
    }
  }, [t]);

  const loadStateDrift = useCallback(async () => {
    try {
      const drift = await fetchRegistrationStateDrift();
      if (!drift) {
        return null;
      }
      setStateDrift(drift);
      return drift;
    } catch (error) {
      console.error(error);
      return null;
    }
  }, []);

  const refreshRegistrationStatus = useCallback(async () => {
    try {
      const statusResult = await fetchRegistrationStatusResult();
      if (!statusResult.ok) {
        captureHubWarning(
          'Device registration status temporarily unavailable',
          {
            status: statusResult.status,
          },
          { dedupeKey: `device-registration-status:${statusResult.status}` },
        );
        throw new Error(t('DEVICE_REGISTRATION_FETCH_STATUS_FAILED'));
      }

      const status = statusResult.data as RegistrationStatus;
      lastStatusFetchSucceededRef.current = true;
      setRegistrationStatus(status);
      setStatusError(null);

      if (requiresDeviceRegistration(status)) {
        completionStartedRef.current = false;
        clearRegistrationCache();

        if (isRegistrationPending(status)) {
          setDriftDialogOpen(false);
          return status;
        }

        if (status.phase === 'unregistered') {
          await loadDeviceInfo();
          const pairingInProgress = pairingInProgressRef.current || pendingPairTargetRef.current !== null;
          if (pairingInProgress) {
            setDriftDialogOpen(false);
          } else {
            const drift = await loadStateDrift();
            const storedChoice = getStoredDriftChoice();
            if (drift?.detected && !storedChoice) {
              setDriftDialogOpen(true);
            }
          }
        }
        return status;
      }

      if (isRegistrationOperational(status)) {
        cacheRegistrationStatus(status);
        // A registered Hub whose public tunnel is degraded (tunnel_token_missing)
        // renders the re-pair form. Load the device info it needs — the device ID
        // and the device-scoped Portal Add-Device URL — just like the unregistered
        // path, otherwise the form is stuck on "Loading device ID..." and its login
        // link falls back to the generic Portal URL.
        if (requiresPortalRePairing(status)) {
          await loadDeviceInfo();
        }
        return status;
      }

      clearRegistrationCache();

      return status;
    } catch (error) {
      console.error(error);
      lastStatusFetchSucceededRef.current = false;
      captureHubWarning(
        'Device registration status temporarily unavailable',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { dedupeKey: 'device-registration-status:exception' },
      );
      setStatusError(t('DEVICE_REGISTRATION_STATUS_TEMPORARY_UNAVAILABLE'));
      setRegistrationStatus((previous) => {
        if (!previous) {
          return null;
        }

        // Avoid acting on stale operational status while the API is unreachable.
        if (isRegistrationOperational(previous) && !requiresDeviceRegistration(previous)) {
          return null;
        }

        return previous;
      });
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [loadDeviceInfo, loadStateDrift, t]);

  const finishRegistrationFlow = useCallback(
    async (status: RegistrationStatus) => {
      const { domain, subdomain } = pendingPairTargetRef.current ?? {};
      pendingPairTargetRef.current = null;
      cacheRegistrationStatus(status);

      if (isTauri) {
        setRedirectStatusKey('DEVICE_REGISTRATION_COMPLETE_LOADING_LOCAL');
        await sleep(1500);
        window.location.href = '/login';
        return;
      }

      if (status.phase === 'degraded') {
        setRedirectStatusKey('DEVICE_REGISTRATION_LOCAL_READY_PUBLIC_NEEDS_ATTENTION_REDIRECTING');
        toast(t('DEVICE_REGISTRATION_LOCAL_READY_PUBLIC_NEEDS_ATTENTION_TOAST'), { duration: 8000 });
        await sleep(2000);
        navigate('/login', { replace: true });
        return;
      }

      if (domain && subdomain) {
        const fullUrl = `https://${subdomain}.${domain}`;
        setRedirectStatusKey('DEVICE_REGISTRATION_LOCAL_SETUP_COMPLETE_CHECKING_PUBLIC_URL');

        let consecutiveSuccesses = 0;
        for (let attempt = 1; attempt <= MAX_DOMAIN_PROBE_ATTEMPTS; attempt++) {
          try {
            const probeData = await probeRegistrationDomain(fullUrl);
            if (probeData?.ready) {
              consecutiveSuccesses++;
              if (consecutiveSuccesses >= REQUIRED_CONSECUTIVE_PROBES) {
                setRedirectStatusKey('DEVICE_REGISTRATION_PUBLIC_URL_READY_REDIRECTING');
                window.location.href = `${fullUrl}/login`;
                return;
              }
              continue;
            }
          } catch {
            // Keep retrying while the tunnel and DNS settle.
          }

          // Any failure resets the streak.
          consecutiveSuccesses = 0;

          if (attempt >= 12) {
            setRedirectStatusKey('DEVICE_REGISTRATION_WAITING_DNS_PROPAGATION');
          }
          if (attempt >= 36) {
            setRedirectStatusKey('DEVICE_REGISTRATION_STILL_WAITING_PUBLIC_URL');
          }

          await sleep(DOMAIN_PROBE_INTERVAL_MS);
        }

        setRedirectStatusKey('DEVICE_REGISTRATION_PUBLIC_ROUTE_PROPAGATING_REDIRECTING_LOCAL');
        toast(t('DEVICE_REGISTRATION_CLOUDFLARE_PROPAGATING_TOAST'), { duration: 8000 });
        await sleep(2000);
        navigate('/login', { replace: true });
        return;
      }

      setRedirectStatusKey('DEVICE_REGISTRATION_COMPLETE_REDIRECTING_LOCAL');
      await sleep(1000);
      navigate('/login', { replace: true });
    },
    [isTauri, navigate, t],
  );

  useEffect(() => {
    void refreshRegistrationStatus();
  }, [refreshRegistrationStatus]);

  useEffect(() => {
    // Keep polling while:
    // - phase is in-progress (paired/provisioning)
    // - phase is unregistered — poll at a slower rate to detect headless setup completing externally
    const isUnregistered = registrationStatus?.phase === 'unregistered';
    const shouldPoll = !statusError && ((registrationStatus && isRegistrationPending(registrationStatus)) || isUnregistered);

    if (!shouldPoll) {
      return;
    }

    const intervalMs = isUnregistered ? HEADLESS_POLL_INTERVAL_MS : STATUS_POLL_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      void refreshRegistrationStatus();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshRegistrationStatus, registrationStatus, statusError]);

  useEffect(() => {
    if (
      !registrationStatus ||
      !lastStatusFetchSucceededRef.current ||
      !isRegistrationOperational(registrationStatus) ||
      completionStartedRef.current
    ) {
      return;
    }

    if (requiresDeviceRegistration(registrationStatus)) {
      return;
    }

    const target = pendingPairTargetRef.current;
    if (target) {
      // Phase is operational (locally_ready, publicly_ready, or degraded) — proceed immediately.
      completionStartedRef.current = true;
      void finishRegistrationFlow(registrationStatus);
      return;
    }

    // Registered Hub with a degraded public tunnel (tunnel_token_missing) and no
    // pairing in flight: the user navigated here to re-pair (e.g. from the
    // dashboard banner). Keep them on the pairing form instead of bouncing back
    // to the local app.
    if (requiresPortalRePairing(registrationStatus)) {
      return;
    }

    navigate('/login', { replace: true });
  }, [finishRegistrationFlow, navigate, registrationStatus]);

  useEffect(() => {
    const showsPairingForm =
      registrationStatus?.phase === 'unregistered' || (registrationStatus != null && requiresPortalRePairing(registrationStatus));
    if (!isLoading && showsPairingForm && deviceId && pairingInputRef.current) {
      pairingInputRef.current.focus();
    }
  }, [deviceId, isLoading, registrationStatus]);

  const doPair = useCallback(
    async (code: string) => {
      pairingInProgressRef.current = true;
      setIsPairing(true);
      setPairingError(null);
      setStatusError(null);
      setDeviceInfoError(null);
      completionStartedRef.current = false;

      try {
        const { ok, data } = await pairWithCode(code);

        if (ok && data.success) {
          pendingPairTargetRef.current = { domain: data.domain, subdomain: data.subdomain };
          setPairingCode('');
          setRegistrationStatus({ phase: 'paired', degradedReasons: [], registered: false });
          setRedirectStatusKey('DEVICE_REGISTRATION_PROVISIONING_STATUS');
          toast.success(t('DEVICE_REGISTRATION_PAIRING_ACCEPTED'));
          await refreshRegistrationStatus();
        } else {
          const errorMsg = typeof data.message === 'string' ? data.message : t('DEVICE_REGISTRATION_FAILED');
          setPairingError(errorMsg);
          toast.error(errorMsg);
        }
      } catch (error) {
        console.error(error);
        setPairingError(t('DEVICE_REGISTRATION_FAILED_RETRY'));
      } finally {
        pairingInProgressRef.current = false;
        setIsPairing(false);
      }
    },
    [refreshRegistrationStatus, t],
  );

  useEffect(() => {
    if (!isTauri) {
      return;
    }

    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<string>('deep-link-pair', (event) => {
          const code = event.payload.trim().toUpperCase();
          if (code.length !== 6) {
            return;
          }

          stashPendingPairingCode(code);
          setPendingDeepLinkCode(code);
        });
      } catch {
        // Tauri event bridge unavailable in non-desktop contexts.
      }
    })();

    return () => {
      void unlisten?.();
    };
  }, [isTauri]);

  useEffect(() => {
    if (!canAutoPairFromDeepLink) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const pendingCode = (pendingDeepLinkCode && normalizePairingCode(pendingDeepLinkCode)) ?? (await resolvePendingPairingCode());
      if (cancelled || !pendingCode || deepLinkPairAttemptRef.current === pendingCode) {
        return;
      }

      deepLinkPairAttemptRef.current = pendingCode;
      setPendingDeepLinkCode(null);
      setPairingCode(pendingCode);
      await doPair(pendingCode);
    })();

    return () => {
      cancelled = true;
    };
  }, [canAutoPairFromDeepLink, doPair, pendingDeepLinkCode]);

  const handleSetupNewDevice = async () => {
    setIsPreparingFresh(true);
    try {
      const { ok, data } = await prepareFreshRegistrationDetailed();
      if (!ok || !data.success) {
        toast.error(data.message ?? t('DEVICE_REGISTRATION_STATE_DRIFT_PREPARE_FAILED'));
        return;
      }

      storeDriftChoice('fresh');
      setDriftChoice('fresh');
      setDriftDialogOpen(false);
      toast.success(t('DEVICE_REGISTRATION_STATE_DRIFT_PREPARE_SUCCESS'));
      await refreshRegistrationStatus();
      await loadStateDrift();
    } catch (error) {
      console.error(error);
      toast.error(t('DEVICE_REGISTRATION_STATE_DRIFT_PREPARE_FAILED'));
    } finally {
      setIsPreparingFresh(false);
    }
  };

  const handleRestoreExistingDevice = async () => {
    try {
      const { ok, data } = await markRegistrationRestoreIntentDetailed();
      if (!ok || !data.success) {
        toast.error(data.message ?? t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_INTENT_FAILED'));
        return;
      }
    } catch (error) {
      console.error(error);
      toast.error(t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_INTENT_FAILED'));
      return;
    }

    storeDriftChoice('restore');
    setDriftChoice('restore');
    setDriftDialogOpen(false);
  };

  const handleRetryStatus = async () => {
    setStatusError(null);
    await refreshRegistrationStatus();
  };

  const handlePair = async () => {
    const code = pairingCode.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError(t('DEVICE_REGISTRATION_PAIRING_CODE_LENGTH'));
      return;
    }
    await doPair(code);
  };

  const handleCopyDeviceId = async () => {
    if (!deviceId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(deviceId);
      toast.success(t('DEVICE_REGISTRATION_DEVICE_ID_COPIED'));
    } catch {
      toast.error(t('DEVICE_REGISTRATION_DEVICE_ID_COPY_FAILED'));
    }
  };

  const portalUrl = portalBaseUrl || DEFAULT_PORTAL_URL;
  // When restoring an existing device, the user already has a device in Portal
  // and just needs to grab/regenerate its pairing code — so send them straight
  // to their Portal home instead of the device-scoped registration (Add Device)
  // intent URL, which kicks off the "create a new device" flow. For a fresh or
  // brand-new device, prefer the device-scoped registration URL so Portal can
  // route into Add Device pairing.
  const loginUrl = driftChoice === 'restore' ? `${portalUrl}/home` : (registrationUrl ?? portalUrl);
  const signupUrl = buildPortalSignupUrl(portalUrl, deviceId);
  const redirectStatus = t(redirectStatusKey);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('DEVICE_REGISTRATION_CHECKING_STATUS')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('DEVICE_REGISTRATION_PLEASE_WAIT')}</p>
        </div>
      </div>
    );
  }

  const showProgressState =
    (registrationStatus && isRegistrationPending(registrationStatus)) ||
    (registrationStatus && isRegistrationOperational(registrationStatus) && Boolean(pendingPairTargetRef.current));

  if (showProgressState) {
    const progressCopy = getProgressCopy(registrationStatus, redirectStatus, t);
    const showSuccessIcon = registrationStatus?.registered;

    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        {showSuccessIcon ? (
          <CheckCircle2 role="img" aria-label={t('COMMON_SUCCESS')} className="h-10 w-10 text-green-500" />
        ) : (
          <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-10 w-10 animate-spin text-primary" />
        )}
        <div>
          <div className="flex items-center justify-center gap-1 flex-wrap">
            {progressCopy.hint ? (
              <HintText
                id={`reg-progress-${registrationStatus?.phase}`}
                hint={progressCopy.hint}
                as="h2"
                className="text-xl font-semibold text-foreground"
              >
                {progressCopy.title}
              </HintText>
            ) : (
              <h2 className="text-xl font-semibold text-foreground">{progressCopy.title}</h2>
            )}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{progressCopy.description}</p>
        </div>

        {statusError && (
          <Alert variant="warning" className="w-full text-left">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <AlertCircle role="img" aria-label={t('COMMON_WARNING')} className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {registrationStatus?.phase === 'paired' || registrationStatus?.phase === 'provisioning'
                    ? t('DEVICE_REGISTRATION_PROGRESS_CONTACT_LOST')
                    : statusError}
                </span>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Button variant="outline" onClick={() => void handleRetryStatus()} disabled={isPairing}>
          {t('COMMON_CHECK_AGAIN')}
        </Button>
      </div>
    );
  }

  if (statusError && !registrationStatus) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        <AlertCircle role="img" aria-label={t('COMMON_ERROR')} className="h-12 w-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('DEVICE_REGISTRATION_STATUS_UNAVAILABLE')}</h2>
          <p className="mt-3 text-sm text-muted-foreground">{statusError}</p>
        </div>
        <Button onClick={() => void handleRetryStatus()}>{t('DEVICE_REGISTRATION_RETRY_STATUS_CHECK')}</Button>
      </div>
    );
  }

  if (
    registrationStatus &&
    isRegistrationOperational(registrationStatus) &&
    !requiresPortalRePairing(registrationStatus) &&
    !pendingPairTargetRef.current &&
    lastStatusFetchSucceededRef.current
  ) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('DEVICE_REGISTRATION_COMPLETE')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('DEVICE_REGISTRATION_LOADING_HUB')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <RegistrationStateDriftDialog
        open={driftDialogOpen}
        drift={stateDrift}
        isPreparing={isPreparingFresh}
        onSetupNew={() => void handleSetupNewDevice()}
        onRestore={handleRestoreExistingDevice}
      />

      {registrationStatus && requiresPortalRePairing(registrationStatus) && (
        <Alert variant="warning">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label={t('COMMON_WARNING')} className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('DEVICE_REGISTRATION_REPAIR_NOTICE_MESSAGE')}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {driftChoice === 'restore' ? <RegistrationRestoreBanner /> : null}

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-5">
        <section className="flex flex-col rounded-lg border border-border/60 bg-muted/20 p-6 md:p-8">
          <div className="flex items-start gap-1 flex-wrap">
            <HintText
              id="reg-account"
              hint={t(REGISTRATION_ACCOUNT_HINT)}
              as="h2"
              className="text-lg font-semibold leading-snug text-foreground md:text-xl"
            >
              {t('DEVICE_REGISTRATION_STEP_1_TITLE')}
            </HintText>
          </div>
          <div className="mt-6 space-y-2">
            {/*
              Invisible, matching Step 2's "Current Device ID:" label line
              in height. Step 2's first row is a label-then-box pair; this
              row is just a button. Without this spacer the two panels'
              first rows start at different heights and everything below
              them drifts out of alignment between the columns.
            */}
            <div className="text-sm text-muted-foreground invisible select-none" aria-hidden="true">
              &nbsp;
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild className="h-10 flex-1 text-sm font-semibold md:h-11 md:text-base" intent="primary">
                <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                  {t('DEVICE_REGISTRATION_LOGIN_TO_COMPANION')}
                </a>
              </Button>
              <ScanQrDisclosure value={loginUrl} label={t('DEVICE_REGISTRATION_SCAN_QR')} summaryLabel={t('DEVICE_REGISTRATION_SCAN_QR_SIGN_IN')} />
            </div>
          </div>
          <div className="mt-3 space-y-2 border-t border-border/60 pt-2">
            <p className="text-sm text-muted-foreground">{t('DEVICE_REGISTRATION_NO_ACCOUNT_YET')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" className="h-10 flex-1 text-sm font-semibold md:h-11 md:text-base">
                <a href={signupUrl} target="_blank" rel="noopener noreferrer">
                  {t('DEVICE_REGISTRATION_CREATE_ACCOUNT')}
                </a>
              </Button>
              <ScanQrDisclosure
                value={signupUrl}
                label={t('DEVICE_REGISTRATION_SCAN_QR')}
                summaryLabel={t('DEVICE_REGISTRATION_SCAN_QR_CREATE_ACCOUNT')}
              />
            </div>
          </div>
        </section>

        <div aria-hidden="true" className="hidden items-center justify-center self-stretch text-muted-foreground md:flex">
          <ChevronRight className="h-8 w-8" />
        </div>

        <section className="flex flex-col rounded-lg border border-border/60 bg-muted/20 p-6 md:p-8">
          <h2 className="text-lg font-semibold leading-snug text-foreground md:text-xl">{t('DEVICE_REGISTRATION_STEP_2_TITLE')}</h2>

          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">
                <LabelWithHint label={t('DEVICE_REGISTRATION_CURRENT_DEVICE_ID')} hint={t(REGISTRATION_DEVICE_ID_HINT)} hintId="reg-device-id" />
              </div>
              <div className="flex h-10 items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 md:h-11">
                <p title={deviceId ?? undefined} className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                  {deviceId ?? t('DEVICE_REGISTRATION_LOADING_DEVICE_ID')}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={!deviceId}
                  onClick={() => void handleCopyDeviceId()}
                  aria-label={t('DEVICE_REGISTRATION_COPY_DEVICE_ID')}
                  title={t('DEVICE_REGISTRATION_COPY_DEVICE_ID')}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="pairing-code" className="block text-sm text-muted-foreground">
                <HintText id="reg-pairing-code" hint={t(REGISTRATION_PAIRING_CODE_HINT)}>
                  {t('DEVICE_REGISTRATION_ENTER_PAIRING_CODE')}
                </HintText>
              </label>
              {/*
                Stack below `sm`: the fixed `w-40` button left the code field ~62px wide
                inside the two-column card, so the 6-char placeholder rendered as "AB".
              */}
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="pairing-code"
                  ref={pairingInputRef}
                  placeholder={t('DEVICE_REGISTRATION_PAIRING_CODE_PLACEHOLDER')}
                  value={pairingCode}
                  onChange={(event) => {
                    const value = event.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, '')
                      .slice(0, 6);
                    setPairingCode(value);
                    setPairingError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && pairingCode.length === 6 && !isPairing) {
                      void handlePair();
                    }
                  }}
                  maxLength={6}
                  disabled={isPairing}
                  className={`h-10 min-w-0 flex-1 rounded-md border bg-background/60 px-3 py-1 text-base font-mono tracking-widest shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-11 md:text-sm ${pairingError ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
                />
                <Button
                  intent="primary"
                  onClick={() => void handlePair()}
                  disabled={pairingCode.length !== 6 || isPairing}
                  loading={isPairing}
                  className="h-10 w-full shrink-0 sm:w-40 md:h-11"
                >
                  {isPairing ? t('DEVICE_REGISTRATION_REGISTERING') : t('DEVICE_REGISTRATION_REGISTER')}
                </Button>
              </div>
              {pairingError && <p className="text-[0.8rem] font-medium text-destructive">{pairingError}</p>}
            </div>
          </div>
        </section>
      </div>

      {statusError && (
        <Alert variant="warning">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label={t('COMMON_WARNING')} className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{statusError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {deviceInfoError && (
        <Alert variant="danger">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label={t('COMMON_ERROR')} className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{deviceInfoError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
