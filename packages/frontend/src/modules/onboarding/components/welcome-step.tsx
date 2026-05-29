import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { identifyServices, type DetectedService } from '../helpers/service-detection';
import { IconBadge, WizardCard } from './wizard-ui';

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
    <WizardCard className="text-center">
      <div className="flex flex-col items-center">
        <IconBadge>
          <Sparkles />
        </IconBadge>
        <h2 className="mt-5 text-2xl font-bold tracking-tight">Welcome to Companion Hub</h2>
        <p className="mt-2 max-w-md text-muted-foreground">
          Let's get your private, local-first ecosystem set up. We'll inspect the Docker services running on this device and recommend open-source
          alternatives you can install with one click.
        </p>
        <Button intent="primary" onClick={handleDetect} loading={loading} disabled={loading} className="mt-6 w-64">
          Continue to AI Setup
        </Button>
      </div>
    </WizardCard>
  );
};
