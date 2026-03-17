import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';

const DEFAULT_PORTAL_URL = 'https://portal.companionintelligence.com';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [portalBaseUrl, setPortalBaseUrl] = useState<string>(DEFAULT_PORTAL_URL);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pairingCode, setPairingCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingSuccess, setPairingSuccess] = useState(false);
  const [redirectStatus, setRedirectStatus] = useState<string>('Setting up your Hub...');
  const pairingInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading && deviceId && pairingInputRef.current) {
      pairingInputRef.current.focus();
    }
  }, [isLoading, deviceId]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            navigate('/');
            return;
          }
        }

        const deviceRes = await fetch('/api/registration/device-id');
        if (deviceRes.ok) {
          const deviceData = await deviceRes.json();
          setDeviceId(deviceData.device_id);
          const base = deviceData.ci_cloud_url?.trim();
          if (base) {
            setPortalBaseUrl(base.replace(/\/+$/, ''));
          }
        } else {
          setError('Failed to get device information');
        }
      } catch (e) {
        setError('Failed to check registration status');
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    };

    checkStatus();
  }, [navigate]);

  const handlePair = async () => {
    const code = pairingCode.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError('Pairing code must be exactly 6 characters.');
      return;
    }

    setIsPairing(true);
    setPairingError(null);
    setError(null);

    try {
      const res = await fetch('/api/registration/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairing_code: code }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setPairingSuccess(true);
        toast.success('Device registered successfully!');

        const { domain, subdomain } = data as { domain?: string; subdomain?: string };
        if (domain && subdomain) {
          const fullUrl = `https://${subdomain}.${domain}`;
          setRedirectStatus('Waiting for DNS propagation...');

          const maxAttempts = 24; // 2 minutes at 5s intervals
          let reachable = false;

          for (let i = 0; i < maxAttempts; i++) {
            try {
              await fetch(fullUrl, { mode: 'no-cors', cache: 'no-store' });
              reachable = true;
              break;
            } catch {
              // not reachable yet
            }

            if (i >= 12) {
              setRedirectStatus('Almost there...');
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
          }

          setRedirectStatus(reachable ? 'Redirecting...' : 'Redirecting (DNS may still be propagating)...');
          window.location.href = `${fullUrl}/login`;
        } else {
          // Fallback: no domain info, just redirect locally
          setTimeout(() => {
            navigate('/', { replace: true });
          }, 2000);
        }
      } else {
        const errorMsg = typeof data.message === 'string' ? data.message : 'Registration failed.';
        setPairingError(errorMsg);
        toast.error(errorMsg);
      }
    } catch (e) {
      setPairingError('Failed to register device. Please try again.');
      console.error(e);
    } finally {
      setIsPairing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-4 text-center py-4">
        <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Checking registration status...</h2>
          <p className="text-sm text-muted-foreground mt-1">Please wait.</p>
        </div>
      </div>
    );
  }

  if (pairingSuccess) {
    return (
      <div className="flex flex-col items-center gap-4 text-center py-4 max-w-md mx-auto">
        <CheckCircle2 role="img" aria-label="success" className="h-12 w-12 text-green-500" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Device Registered Successfully</h2>
          <p className="text-sm text-muted-foreground mt-3">{redirectStatus}</p>
        </div>
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">Device Registration Required</h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        Enter the 6-character pairing code from{' '}
        <a href={portalBaseUrl || DEFAULT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
          CI Portal
        </a>{' '}
        to register this device.
      </p>

      {deviceId && (
        <div className="mb-4 p-3 bg-muted/50 rounded-lg">
          <p className="text-xs text-muted-foreground mb-1">Device ID</p>
          <p className="font-mono text-sm break-all">{deviceId}</p>
        </div>
      )}

      {error && (
        <Alert variant="danger" className="mb-4">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle role="img" aria-label="error" className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="mb-6 space-y-2">
        <label htmlFor="pairing-code" className="text-sm font-medium leading-none block">
          Pairing Code
        </label>
        <div className="flex gap-2">
          <input
            id="pairing-code"
            ref={pairingInputRef}
            placeholder="ABC123"
            value={pairingCode}
            onChange={(e) => {
              const val = e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 6);
              setPairingCode(val);
              setPairingError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pairingCode.length === 6 && !isPairing) {
                handlePair();
              }
            }}
            maxLength={6}
            disabled={isPairing}
            className={`flex-1 h-9 rounded-md border bg-transparent px-3 py-1 text-base shadow-sm transition-colors font-mono tracking-widest placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${pairingError ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
          />
          <Button intent="primary" onClick={handlePair} disabled={pairingCode.length !== 6 || isPairing} loading={isPairing}>
            {isPairing ? 'Registering...' : 'Register'}
          </Button>
        </div>
        {pairingError && <p className="text-[0.8rem] font-medium text-destructive">{pairingError}</p>}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Don&apos;t have a pairing code?{' '}
        <a href={portalBaseUrl || DEFAULT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
          Visit CI Portal
        </a>{' '}
        to create an account and add a device.
      </p>
    </>
  );
}
