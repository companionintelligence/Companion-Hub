import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import toast from 'react-hot-toast';
import { useUserContext } from '@/context/user-context';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { domain } = useUserContext();
  const [isRegistered, setIsRegistered] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [registrationUrl, setRegistrationUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check if this is a callback from CI Cloud
  const isCallback =
    searchParams.has('device_id') &&
    searchParams.has('organization_id') &&
    searchParams.has('organization_name') &&
    searchParams.has('subdomain') &&
    searchParams.has('slug');

  // Handle callback from CI Cloud
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

            // Redirect to the new subdomain
            // Default to domain from config if provided
            // Note: In production this should align with the cloud domain
            const subdomain = params.subdomain;
            if (subdomain) {
              const targetUrl = `https://${subdomain}.${domain}`;
              setTimeout(() => {
                window.location.href = targetUrl;
              }, 1500);
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

    // Check registration status on mount
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

        // Get device ID and registration URL
        const deviceRes = await fetch('/api/registration/device-id');
        if (deviceRes.ok) {
          const deviceData = await deviceRes.json();
          setDeviceId(deviceData.device_id);
          setRegistrationUrl(deviceData.registration_url);

          // If no registration URL, show helpful error
          if (!deviceData.registration_url) {
            setError(
              'CI Cloud frontend URL not configured. ' +
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

  const handleRedirectToCICloud = () => {
    if (registrationUrl) {
      window.location.href = registrationUrl;
    } else {
      toast.error('Registration URL not available');
    }
  };

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
        <h1 className="text-2xl font-bold text-foreground">Registering Device...</h1>
        <p className="text-muted-foreground max-w-md">Please wait while your device is registered.</p>
      </div>
    );
  }

  // Show callback processing state
  if (isCallback) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
        <h1 className="text-2xl font-bold text-foreground">Setting up device...</h1>
        <p className="text-muted-foreground max-w-md">Starting Cloudflare tunnel and configuring access...</p>
        {error && (
          <Alert variant="danger" className="max-w-md">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <IconAlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  // If already registered, redirect
  if (isRegistered) {
    return null; // Will navigate away
  }

  // Show registration redirect page
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6">
      <div className="card w-full max-w-md">
        <div className="card-body">
          <h1 className="text-2xl font-bold text-center mb-4">Device Registration Required</h1>
          <p className="text-muted-foreground text-center mb-6">
            This device needs to be registered with CI Cloud to access the app store. You will be redirected to complete the registration process.
          </p>

          {deviceId && (
            <div className="mb-4 p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground mb-1">Device ID:</p>
              <p className="font-mono text-sm">{deviceId}</p>
            </div>
          )}

          {error && (
            <Alert variant="danger" className="mb-4">
              <AlertDescription>
                <div className="flex items-start gap-2">
                  <IconAlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {registrationUrl && (
            <>
              <Button intent="primary" className="w-full" onClick={handleRedirectToCICloud}>
                Register Device on CI Cloud
                <IconExternalLink className="ml-2 h-4 w-4" />
              </Button>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                You will be redirected to CI Cloud to sign in, create an organization, and complete device registration.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
