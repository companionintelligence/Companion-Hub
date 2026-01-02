import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState('Checking registration status...');
  const [error, setError] = useState('');

  useEffect(() => {
    const subdomain = searchParams.get('subdomain');
    const registrationId = searchParams.get('registration_id');

    const completeRegistration = async () => {
      if (subdomain && registrationId) {
        setStatus('Completing registration...');
        try {
          const res = await fetch('/api/registration/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdomain, registrationId }),
          });
          if (res.ok) {
            setStatus('Registration complete! Redirecting...');
            setTimeout(() => navigate('/login'), 1000);
            return;
          }
          setError('Failed to complete registration.');
        } catch (e) {
          setError('Error completing registration.');
          console.error(e);
        }
      } else {
        checkStatus();
      }
    };

    const checkStatus = async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            navigate('/login');
          } else if (data.registrationUrl) {
            const callbackUrl = encodeURIComponent(`${window.location.origin}/device-registration`);
            window.location.href = `${data.registrationUrl}&callback_url=${callbackUrl}`;
          }
        }
      } catch (e) {
        console.error(e);
        setError('Failed to check status.');
      }
    };

    completeRegistration();
  }, [navigate, searchParams]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
        <h1 className="text-2xl font-bold text-red-500">Error</h1>
        <p className="text-muted-foreground max-w-md">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      <h1 className="text-2xl font-bold text-foreground">{status}</h1>
      <p className="text-muted-foreground max-w-md">Please wait...</p>
    </div>
  );
}
