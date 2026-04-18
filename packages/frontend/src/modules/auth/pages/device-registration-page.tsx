import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import type { RegistrationStatus } from '@/lib/registration-status';
import { isRegistrationOperational, isRegistrationPending } from '@/lib/registration-status';
import toast from 'react-hot-toast';

const DEFAULT_PORTAL_URL = 'https://portal.companionintelligence.com';
const STATUS_POLL_INTERVAL_MS = 3000;
const DOMAIN_PROBE_INTERVAL_MS = 5000;
const MAX_DOMAIN_PROBE_ATTEMPTS = 60;

type PairingTarget = {
  domain?: string;
  subdomain?: string;
};

function setRegisteredCache() {
  sessionStorage.setItem('device-registered', 'true');
  sessionStorage.setItem('device-registered-at', String(Date.now()));
}

function clearRegisteredCache() {
  sessionStorage.removeItem('device-registered');
  sessionStorage.removeItem('device-registered-at');
}

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
        title: 'Pairing accepted',
        description: 'Your pairing code worked. We are finishing local Hub setup before moving on.',
      };
    case 'provisioning':
      return {
        title: 'Setting up your Hub',
        description: 'We are configuring local services and your public route. This can take a minute.',
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

  const refreshRegistrationStatus = useCallback(
    async ({ loadDeviceData = false }: { loadDeviceData?: boolean } = {}) => {
      try {
        const res = await apiFetch('/api/registration/status');
        if (!res.ok) {
          throw new Error('Failed to fetch registration status');
        }

        const status = (await res.json()) as RegistrationStatus;
        setRegistrationStatus(status);
        setStatusError(null);

        if (isRegistrationOperational(status)) {
          setRegisteredCache();
          return status;
        }

        clearRegisteredCache();

        if (loadDeviceData && status.phase === 'unregistered') {
          await loadDeviceInfo();
        }

        return status;
      } catch (error) {
        console.error(error);
        setStatusError('We couldn’t confirm your Hub status right now. This is usually temporary. Please retry in a moment.');
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [loadDeviceInfo],
  );

  const finishRegistrationFlow = useCallback(
    async (status: RegistrationStatus) => {
      const { domain, subdomain } = pendingPairTargetRef.current ?? {};
      pendingPairTargetRef.current = null;
      setRegisteredCache();

      const isTauri = '__TAURI_INTERNALS__' in window;
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

        for (let attempt = 1; attempt <= MAX_DOMAIN_PROBE_ATTEMPTS; attempt++) {
          try {
            const probeRes = await apiFetch(`/api/registration/probe-domain?url=${encodeURIComponent(fullUrl)}`);
            if (probeRes.ok) {
              const probeData = (await probeRes.json()) as { ready: boolean };
              if (probeData.ready) {
                setRedirectStatus('Public Hub URL is ready. Redirecting...');
                window.location.href = `${fullUrl}/login`;
                return;
              }
            }
          } catch {
            // Keep retrying while the tunnel and DNS settle.
          }

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
    [navigate],
  );

  useEffect(() => {
    void refreshRegistrationStatus({ loadDeviceData: true });
  }, [refreshRegistrationStatus]);

  useEffect(() => {
    if (!registrationStatus || !isRegistrationPending(registrationStatus)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshRegistrationStatus();
    }, STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshRegistrationStatus, registrationStatus]);

  useEffect(() => {
    if (!registrationStatus || !isRegistrationOperational(registrationStatus) || completionStartedRef.current) {
      return;
    }

    if (pendingPairTargetRef.current) {
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

  const handleRetryStatus = async () => {
    setStatusError(null);
    await refreshRegistrationStatus({ loadDeviceData: registrationStatus?.phase === 'unregistered' || !registrationStatus });
  };

  const handlePair = async () => {
    const code = pairingCode.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError('Pairing code must be exactly 6 characters.');
      return;
    }

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
        setRedirectStatus('Pairing accepted. Finishing local Hub setup...');
        toast.success('Pairing code accepted. Finishing setup...');
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
  };

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
                <AlertCircle role="img" aria-label="warning" className="mt-0.5 h-4 w-4 flex-shrink-0" />
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
    <>
      <h2 className="mb-4 text-center text-xl font-semibold">Device Registration Required</h2>
      <p className="mb-6 text-center text-sm text-muted-foreground">
        Enter the 6-character pairing code from{' '}
        <a href={portalBaseUrl || DEFAULT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
          CI Portal
        </a>{' '}
        to register this device.
      </p>

      {deviceId && (
        <div className="mb-4 rounded-lg bg-muted/50 p-3">
          <p className="mb-1 text-xs text-muted-foreground">Device ID</p>
          <p className="break-all font-mono text-sm">{deviceId}</p>
        </div>
      )}

      {statusError && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label="warning" className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{statusError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {deviceInfoError && (
        <Alert variant="danger" className="mb-4">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label="error" className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{deviceInfoError}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-6 space-y-2">
        <label htmlFor="pairing-code" className="block text-sm font-medium leading-none">
          Pairing Code
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
            className={`flex-1 h-9 rounded-md border bg-transparent px-3 py-1 text-base font-mono tracking-widest shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${pairingError ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
          />
          <Button intent="primary" onClick={() => void handlePair()} disabled={pairingCode.length !== 6 || isPairing} loading={isPairing}>
            {isPairing ? 'Registering...' : 'Register'}
          </Button>
        </div>
        {pairingError && <p className="text-[0.8rem] font-medium text-destructive">{pairingError}</p>}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Don&apos;t have a pairing code?{' '}
        <a href={portalBaseUrl || DEFAULT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
          Visit CI Portal
        </a>{' '}
        to create an account and add a device.
      </p>
    </>
  );
}
