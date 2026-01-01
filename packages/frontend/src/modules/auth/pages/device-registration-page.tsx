import { useEffect } from 'react';
import { useNavigate } from 'react-router';

export default function DeviceRegistrationPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/registration/status');
        if (res.ok) {
          const data = await res.json();
          if (data.registered) {
            navigate('/');
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    const interval = setInterval(checkStatus, 1000);
    checkStatus(); // Initial check

    return () => clearInterval(interval);
  }, [navigate]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 text-center">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent"></div>
      <h1 className="text-2xl font-bold text-foreground">Confirming Device Registration...</h1>
      <p className="text-muted-foreground max-w-md">
        Please wait while we verify your device registration with the cloud server.
      </p>
    </div>
  );
}
