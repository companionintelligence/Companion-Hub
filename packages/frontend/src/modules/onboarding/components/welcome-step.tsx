import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useState } from 'react';
import { identifyServices, type DetectedService } from '../helpers/service-detection';

interface WelcomeStepProps {
  onDetected: (services: DetectedService[]) => void;
}

export const WelcomeStep = ({ onDetected }: WelcomeStepProps) => {
  const [loading, setLoading] = useState(false);

  const handleDetect = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/system/detect-services', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to detect services');
      const data = await res.json();
      const detected = identifyServices(data.services || []);
      onDetected(detected);
    } catch (e) {
      onDetected([]);
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-8 text-center">
        <div className="mb-6">
          <div className="text-5xl mb-4">👋</div>
          <h2 className="text-xl font-semibold mb-2">Welcome to Companion Hub</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Let's get your self-hosted ecosystem set up. We'll inspect Docker services running on this device and recommend open-source alternatives
            you can install with one click.
          </p>
        </div>

        <div className="flex flex-col gap-3 items-center">
          <Button intent="primary" onClick={handleDetect} loading={loading} disabled={loading} className="w-64">
            Continue to AI Setup
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
