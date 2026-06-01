import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { AlertCircle, CheckCircle2, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import type { RegistrationStatus } from '@/lib/registration-status';
import { isRegistrationOperational, isRegistrationPending, requiresDeviceRegistration } from '@/lib/registration-status';
import { cacheRegistrationStatus, clearRegistrationCache } from '@/lib/registration-cache';
import toast from 'react-hot-toast';

const DEFAULT_PORTAL_URL = (
  (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim() ||
  (import.meta.env.DEV ? 'https://hub.companionintelligence.com' : 'https://hub.ci.computer')
).replace(/\/+$/, '');
const STATUS_POLL_INTERVAL_MS = 3000;
const HEADLESS_POLL_INTERVAL_MS = 5000; // slower poll when idle, waiting for external registration
const DOMAIN_PROBE_INTERVAL_MS = 5000;
const MAX_DOMAIN_PROBE_ATTEMPTS = 60;
const REQUIRED_CONSECUTIVE_PROBES = 2;

type PairingTarget = {
  domain?: string;
  subdomain?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProgressCopy(status: RegistrationStatus | null, redirectStatus: string) {
  if (!status) {
    return {
      title: 'Checking registration status...',
      description: 'Please wait while we confirm your Hub status.',
    };
  }

  switch (status.phase) {
    case 'paired':
      return {
        title: 'Provisioning your domain',
        description:
          'Your pairing code worked. We are finishing DNS and secure routing for your Hub so it can be reached on the web. That often takes a few minutes—please keep this window open.',
      };
    case 'provisioning':
      return {
        title: 'Setting up your Hub',
        description: 'We are turning on local services and your public connection. DNS propagation can add another minute or two.',
      };
    case 'degraded':
      return {
        title: 'Hub setup needs attention',
        description: redirectStatus,
      };
    default:
      return {
        title: 'Registration complete',
        description: redirectStatus,
      };
  }
}

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [portalBaseUrl, setPortalBaseUrl] = useState<string>(DEFAULT_PORTAL_URL);
  const [isLoading, setIsLoading] = useState(true);
  const [deviceInfoError, setDeviceInfoError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatus | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [redirectStatus, setRedirectStatus] = useState<string>('Setting up your Hub...');

  const pairingInputRef = useRef<HTMLInputElement>(null);
  const pendingPairTargetRef = useRef<PairingTarget | null>(null);
  const completionStartedRef = useRef(false);
  const isTauri = '__TAURI_INTERNALS__' in window;

  const loadDeviceInfo = useCallback(async () => {
    try {
      const deviceRes = await apiFetch('/api/registration/device-id');
      if (!deviceRes.ok) {
        setDeviceInfoError('Failed to get device information');
        return;
      }

      const deviceData = (await deviceRes.json()) as { device_id?: string; ci_cloud_url?: string };
      setDeviceId(deviceData.device_id ?? null);
      const base = deviceData.ci_cloud_url?.trim();
      if (base) {
        setPortalBaseUrl(base.replace(/\/+$/, ''));
      }
      setDeviceInfoError(null);
    } catch (error) {
      console.error(error);
      setDeviceInfoError('Failed to get device information');
    }
  }, []);

  const refreshRegistrationStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registration/status');
      if (!res.ok) {
        throw new Error('Failed to fetch registration status');
      }

      const status = (await res.json()) as RegistrationStatus;
      setRegistrationStatus(status);
      setStatusError(null);

      if (requiresDeviceRegistration(status)) {
        completionStartedRef.current = false;
        clearRegistrationCache();
        if (status.phase === 'unregistered') {
          await loadDeviceInfo();
        }
        return status;
      }

      if (isRegistrationOperational(status)) {
        cacheRegistrationStatus(status);
        return status;
      }

      clearRegistrationCache();

      return status;
    } catch (error) {
      console.error(error);
      setStatusError('We couldn’t confirm your Hub status right now. This is usually temporary. Please retry in a moment.');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [loadDeviceInfo]);

  const finishRegistrationFlow = useCallback(
    async (status: RegistrationStatus) => {
      const { domain, subdomain } = pendingPairTargetRef.current ?? {};
      pendingPairTargetRef.current = null;
      cacheRegistrationStatus(status);

      if (isTauri) {
        setRedirectStatus('Registration complete! Loading the local Hub...');
        await sleep(1500);
        window.location.href = '/';
        return;
      }

      if (status.phase === 'degraded') {
        setRedirectStatus('Your Hub is ready locally, but the public route still needs attention. Redirecting you to the local Hub...');
        toast('Your Hub is ready locally. Public connectivity still needs attention, so we are taking you to the local app.', { duration: 8000 });
        await sleep(2000);
        navigate('/', { replace: true });
        return;
      }

      if (domain && subdomain) {
        const fullUrl = `https://${subdomain}.${domain}`;
        setRedirectStatus('Local setup is complete. Checking your public Hub URL...');

        let consecutiveSuccesses = 0;
        for (let attempt = 1; attempt <= MAX_DOMAIN_PROBE_ATTEMPTS; attempt++) {
          try {
            const probeRes = await apiFetch(`/api/registration/probe-domain?url=${encodeURIComponent(fullUrl)}`);
            if (probeRes.ok) {
              const probeData = (await probeRes.json()) as { ready: boolean };
              if (probeData.ready) {
                consecutiveSuccesses++;
                if (consecutiveSuccesses >= REQUIRED_CONSECUTIVE_PROBES) {
                  setRedirectStatus('Public Hub URL is ready. Redirecting...');
                  window.location.href = `${fullUrl}/login`;
                  return;
                }
                // Don't sleep — immediately re-probe for the next confirmation.
                continue;
              }
            }
          } catch {
            // Keep retrying while the tunnel and DNS settle.
          }

          // Any failure resets the streak.
          consecutiveSuccesses = 0;

          if (attempt >= 12) {
            setRedirectStatus('Waiting for DNS propagation...');
          }
          if (attempt >= 36) {
            setRedirectStatus('Still waiting for your public Hub URL — this can take a few minutes...');
          }

          await sleep(DOMAIN_PROBE_INTERVAL_MS);
        }

        setRedirectStatus('Public route is still propagating. Redirecting to the local Hub for now...');
        toast('Cloudflare tunnel setup is still propagating. You can use your Hub locally while it finishes.', { duration: 8000 });
        await sleep(2000);
        navigate('/', { replace: true });
        return;
      }

      setRedirectStatus('Registration complete! Redirecting to the local Hub...');
      await sleep(1000);
      navigate('/', { replace: true });
    },
    [isTauri, navigate],
  );

  useEffect(() => {
    void refreshRegistrationStatus();
  }, [refreshRegistrationStatus]);

  useEffect(() => {
    // Keep polling while:
    // - phase is in-progress (paired/provisioning)
    // - phase is unregistered — poll at a slower rate to detect headless setup completing externally
    const isUnregistered = registrationStatus?.phase === 'unregistered';
    const shouldPoll = (registrationStatus && isRegistrationPending(registrationStatus)) || isUnregistered;

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
  }, [refreshRegistrationStatus, registrationStatus]);

  useEffect(() => {
    if (!registrationStatus || !isRegistrationOperational(registrationStatus) || completionStartedRef.current) {
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

    navigate('/', { replace: true });
  }, [finishRegistrationFlow, navigate, registrationStatus]);

  useEffect(() => {
    if (!isLoading && registrationStatus?.phase === 'unregistered' && deviceId && pairingInputRef.current) {
      pairingInputRef.current.focus();
    }
  }, [deviceId, isLoading, registrationStatus]);

  const doPair = useCallback(
    async (code: string) => {
      setIsPairing(true);
      setPairingError(null);
      setStatusError(null);
      setDeviceInfoError(null);
      completionStartedRef.current = false;

      try {
        const res = await apiFetch('/api/registration/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairing_code: code }),
        });

        const data = (await res.json()) as { success?: boolean; message?: string; domain?: string; subdomain?: string };

        if (res.ok && data.success) {
          pendingPairTargetRef.current = { domain: data.domain, subdomain: data.subdomain };
          setPairingCode('');
          setRegistrationStatus({ phase: 'paired', degradedReasons: [], registered: false });
          setRedirectStatus(
            'Provisioning your domain and secure connection. DNS and tunnel setup can take a few minutes—please wait on this screen.',
          );
          toast.success('Pairing accepted. Provisioning your domain—this usually takes a few minutes.');
          await refreshRegistrationStatus();
        } else {
          const errorMsg = typeof data.message === 'string' ? data.message : 'Registration failed.';
          setPairingError(errorMsg);
          toast.error(errorMsg);
        }
      } catch (error) {
        console.error(error);
        setPairingError('Failed to register device. Please try again.');
      } finally {
        setIsPairing(false);
      }
    },
    [refreshRegistrationStatus],
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

          setPairingCode(code);
          void doPair(code);
        });
      } catch {
        // Tauri event bridge unavailable in non-desktop contexts.
      }
    })();

    return () => {
      void unlisten?.();
    };
  }, [doPair, isTauri]);

  const handleRetryStatus = async () => {
    setStatusError(null);
    await refreshRegistrationStatus();
  };

  const handlePair = async () => {
    const code = pairingCode.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError('Pairing code must be exactly 6 characters.');
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
      toast.success('Device ID copied to clipboard.');
    } catch {
      toast.error('Failed to copy device ID.');
    }
  };

  const portalUrl = portalBaseUrl || DEFAULT_PORTAL_URL;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Checking registration status...</h2>
          <p className="mt-1 text-sm text-muted-foreground">Please wait.</p>
        </div>
      </div>
    );
  }

  const showProgressState =
    (registrationStatus && isRegistrationPending(registrationStatus)) ||
    (registrationStatus && isRegistrationOperational(registrationStatus) && Boolean(pendingPairTargetRef.current));

  if (showProgressState) {
    const progressCopy = getProgressCopy(registrationStatus, redirectStatus);
    const showSuccessIcon = registrationStatus?.registered;

    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        {showSuccessIcon ? (
          <CheckCircle2 role="img" aria-label="success" className="h-12 w-12 text-green-500" />
        ) : (
          <Loader2 role="img" aria-label="loading" className="h-10 w-10 animate-spin text-primary" />
        )}
        <div>
          <h2 className="text-xl font-semibold text-foreground">{progressCopy.title}</h2>
          <p className="mt-3 text-sm text-muted-foreground">{progressCopy.description}</p>
        </div>

        {statusError && (
          <Alert variant="warning" className="w-full text-left">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <AlertCircle role="img" aria-label="warning" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {registrationStatus?.phase === 'paired' || registrationStatus?.phase === 'provisioning'
                    ? 'We temporarily lost contact while checking progress. We will keep retrying automatically.'
                    : statusError}
                </span>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Button variant="outline" onClick={() => void handleRetryStatus()} disabled={isPairing}>
          Check again
        </Button>
      </div>
    );
  }

  if (statusError && !registrationStatus) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        <AlertCircle role="img" aria-label="error" className="h-12 w-12 text-amber-500" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Registration status temporarily unavailable</h2>
          <p className="mt-3 text-sm text-muted-foreground">{statusError}</p>
        </div>
        <Button onClick={() => void handleRetryStatus()}>Retry status check</Button>
      </div>
    );
  }

  if (registrationStatus && isRegistrationOperational(registrationStatus) && !pendingPairTargetRef.current) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-4 text-center">
        <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Registration complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">Loading your Hub...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-5">
        <section className="flex flex-col rounded-xl border border-border/60 bg-muted/20 p-6 md:p-8">
          <h2 className="text-xl font-semibold leading-snug text-foreground md:text-2xl">Step 1: Get your pairing code</h2>
          <Button asChild className="mt-6 h-12 w-full text-base font-semibold md:h-14 md:text-lg" intent="primary" size="lg">
            <a href={portalUrl} target="_blank" rel="noopener noreferrer">
              Login to Companion Account
            </a>
          </Button>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground md:text-lg">
            Don&apos;t have an account yet?{' '}
            <a
              href={`${portalUrl}/signup`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary underline hover:no-underline"
            >
              Create one free
            </a>{' '}
            — it only takes a moment, and your data stays on this device.
          </p>
        </section>

        <div aria-hidden="true" className="hidden items-center justify-center text-muted-foreground md:flex">
          <ChevronRight className="h-5 w-5" />
        </div>

        <section className="flex flex-col rounded-xl border border-border/60 bg-muted/20 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">Step 2: Connect this device</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Enter the code and use the Current Device ID to complete registration.</p>

          <div className="mt-5 space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Current Device ID:</p>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                <p className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{deviceId ?? 'Loading device ID...'}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={!deviceId}
                  onClick={() => void handleCopyDeviceId()}
                  aria-label="Copy device ID"
                  title="Copy device ID"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="pairing-code" className="block text-sm text-muted-foreground">
                Enter Pairing Code:
              </label>
              <div className="flex gap-2">
                <input
                  id="pairing-code"
                  ref={pairingInputRef}
                  placeholder="ABC123"
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
                  className={`h-9 min-w-0 flex-1 rounded-md border bg-background/60 px-3 py-1 text-base font-mono tracking-widest shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${pairingError ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
                />
                <Button
                  intent="primary"
                  onClick={() => void handlePair()}
                  disabled={pairingCode.length !== 6 || isPairing}
                  loading={isPairing}
                  className="w-40 shrink-0"
                >
                  {isPairing ? 'Registering...' : 'Register'}
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
              <AlertCircle role="img" aria-label="warning" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{statusError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {deviceInfoError && (
        <Alert variant="danger">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label="error" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{deviceInfoError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
