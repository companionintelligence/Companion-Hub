import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserContext } from '@/context/user-context';

const DEFAULT_PORTAL_URL = 'https://portal.companionintelligence.com';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { domain } = useUserContext();
  const [isRegistered, setIsRegistered] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [registrationUrl, setRegistrationUrl] = useState<string | null>(null);
  const [portalBaseUrl, setPortalBaseUrl] = useState<string>(DEFAULT_PORTAL_URL);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pairingCode, setPairingCode] = useState('');
  const [isPairingVerified, setIsPairingVerified] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const pairingInputRef = useRef<HTMLInputElement>(null);
  const [redirectTargetUrl, setRedirectTargetUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && registrationUrl && pairingInputRef.current) {
      pairingInputRef.current.focus();
    }
  }, [isLoading, registrationUrl]);

  const isCallback =
    searchParams.has('device_id') &&
    searchParams.has('organization_id') &&
    searchParams.has('organization_name') &&
    searchParams.has('subdomain') &&
    searchParams.has('slug');

  useEffect(() => {
    if (isCallback) {
      const handleCallback = async () => {
        try {
          const device_id = searchParams.get('device_id');
          const organization_id = searchParams.get('organization_id');
          const organization_name = searchParams.get('organization_name');
          const slug = searchParams.get('slug');
          const subdomain = searchParams.get('subdomain');
          const api_key = searchParams.get('api_key');
          const tunnel_id = searchParams.get('tunnel_id');
          const tunnel_token = searchParams.get('tunnel_token');
          const ca_cert = searchParams.get('ca_cert');

          if (!device_id || !organization_id || !organization_name || !subdomain || !api_key || !tunnel_id || !tunnel_token || !slug) {
            const missing = [];
            if (!device_id) missing.push('device_id');
            if (!organization_id) missing.push('organization_id');
            if (!organization_name) missing.push('organization_name');
            if (!slug) missing.push('slug');
            if (!subdomain) missing.push('subdomain');
            if (!api_key) missing.push('api_key');
            if (!tunnel_id) missing.push('tunnel_id');
            if (!tunnel_token) missing.push('tunnel_token');

            throw new Error(`Missing required registration parameters: ${missing.join(', ')}`);
          }

          const params: Record<string, string> = {
            device_id,
            organization_id,
            organization_name,
            slug,
            subdomain,
            api_key,
            tunnel_id,
            tunnel_token,
          };

          if (ca_cert) {
            params.ca_cert = ca_cert;
          }

          const res = await fetch(`/api/registration/callback?${new URLSearchParams(params).toString()}`);
          const data = await res.json();

          if (res.ok && data.success) {
            toast.success('Device registered successfully!');
            setIsRegistered(true);

            const subdomain = params.subdomain;
            const rootDomain = data.domain || domain;
            const isLocalhost =
              typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            if (subdomain && rootDomain) {
              const targetUrl = `https://${subdomain}.${rootDomain}`;
              const redirectDelayMs = isLocalhost ? (30 + 5) * 1000 : 1500;
              if (isLocalhost) {
                setRedirectTargetUrl(targetUrl);
              }
              setTimeout(() => {
                window.location.href = targetUrl;
              }, redirectDelayMs);
            } else {
              setTimeout(() => {
                navigate('/');
              }, 1500);
            }
          } else {
            setError(data.message || 'Registration failed');
            toast.error(data.message || 'Registration failed');
          }
        } catch (e) {
          setError('Failed to complete registration');
          toast.error('Failed to complete registration');
          console.error(e);
        } finally {
          setIsLoading(false);
        }
      };

      handleCallback();
      return;
    }

    const checkStatus = async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            setIsRegistered(true);
            navigate('/');
            return;
          }
        }

        const deviceRes = await fetch('/api/registration/device-id');
        if (deviceRes.ok) {
          const deviceData = await deviceRes.json();
          setDeviceId(deviceData.device_id);
          setRegistrationUrl(deviceData.registration_url);
          const base = deviceData.ci_cloud_frontend_url?.trim();
          if (base) {
            setPortalBaseUrl(base.replace(/\/+$/, ''));
          }

          if (!deviceData.registration_url) {
            setError(
              'CI Portal frontend URL not configured. ' +
                'Please set CI_CLOUD_FRONTEND_URL environment variable. ' +
                `Current value: ${deviceData.ci_cloud_frontend_url || 'not set'}`,
            );
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
  }, [navigate, searchParams, isCallback, domain]);

  const handleVerifyPairingCode = async () => {
    const code = pairingCode.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingError('Pairing code must be exactly 6 characters.');
      return;
    }

    setIsVerifying(true);
    setPairingError(null);

    try {
      const res = await fetch('/api/registration/verify-pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairing_code: code }),
      });

      const data = await res.json();

      if (data.success) {
        setIsPairingVerified(true);
        toast.success('Pairing code verified! You can now register this device.');
      } else {
        setPairingError(data.message || 'Invalid pairing code.');
        toast.error(data.message || 'Invalid pairing code.');
      }
    } catch (e) {
      setPairingError('Failed to verify pairing code. Please try again.');
      console.error(e);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRedirectToPortal = () => {
    if (registrationUrl) {
      window.location.href = registrationUrl;
    } else {
      toast.error('Registration URL not available');
    }
  };

  if (isLoading) {
    const isProcessingCallback = isCallback;
    return (
      <div className="flex flex-col items-center gap-4 text-center py-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            {isProcessingCallback ? 'Setting up device...' : 'Checking registration status...'}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isProcessingCallback ? 'Starting Cloudflare tunnel and configuring access.' : 'Please wait.'}
          </p>
        </div>
      </div>
    );
  }

  if (isRegistered && redirectTargetUrl) {
    return (
      <div className="flex flex-col items-center gap-4 text-center py-4 max-w-md mx-auto">
        <CheckCircle2 className="h-12 w-12 text-green-500" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Device Registered Successfully</h2>
          <p className="text-sm text-muted-foreground mt-3">
            Please wait about 30 seconds for your portal tunnel to start. You will be redirected automatically.
          </p>
        </div>
      </div>
    );
  }

  if (isCallback && error) {
    return (
      <div className="flex flex-col items-center gap-4 text-center py-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Registration failed</h2>
          <p className="text-sm text-muted-foreground mt-1">We couldn&apos;t complete the device setup.</p>
        </div>
        <Alert variant="danger" className="text-left w-full max-w-md">
          <AlertDescription>
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  }

  if (isRegistered) {
    return null;
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">Device Registration Required</h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        Enter the 6-character pairing code from{' '}
        <a href={portalBaseUrl || DEFAULT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
          CI Portal
        </a>{' '}
        to verify this device before registration.
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
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
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
              if (isPairingVerified) {
                setIsPairingVerified(false);
              }
              setPairingError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pairingCode.length === 6 && !isPairingVerified) {
                handleVerifyPairingCode();
              }
            }}
            maxLength={6}
            disabled={isPairingVerified}
            className={`flex-1 h-9 rounded-md border bg-transparent px-3 py-1 text-base shadow-sm transition-colors font-mono tracking-widest placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm ${pairingError ? 'border-destructive focus-visible:ring-destructive' : 'border-input'}`}
          />
          <Button
            variant="outline"
            onClick={handleVerifyPairingCode}
            disabled={pairingCode.length !== 6 || isVerifying || isPairingVerified}
            loading={isVerifying}
          >
            {isPairingVerified ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : 'Verify'}
          </Button>
        </div>
        {pairingError && <p className="text-[0.8rem] font-medium text-destructive">{pairingError}</p>}
        {isPairingVerified && (
          <p className="text-sm text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Pairing code verified
          </p>
        )}
      </div>

      {registrationUrl && (
        <>
          <Button intent="primary" className="w-full" onClick={handleRedirectToPortal} disabled={!isPairingVerified}>
            Register Device on CI Portal
            <ExternalLink className="ml-2 h-4 w-4" />
          </Button>
          {!isPairingVerified && <p className="text-xs text-muted-foreground mt-2 text-center">Verify your pairing code to enable registration.</p>}
          <p className="text-xs text-muted-foreground mt-4 text-center">
            You will be redirected to CI Portal to sign in, create an organization, and complete device registration.
          </p>
        </>
      )}
    </>
  );
}
