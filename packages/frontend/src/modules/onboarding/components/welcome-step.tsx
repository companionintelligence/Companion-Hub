import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useState } from 'react';
import { identifyServices, type DetectedService } from '../helpers/service-detection';

interface WelcomeStepProps {
  onDetected: (services: DetectedService[]) => void;
  onSkip: () => void;
}

export const WelcomeStep = ({ onDetected, onSkip }: WelcomeStepProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDetect = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/system/detect-services', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to detect services');
      const data = await res.json();
      const detected = identifyServices(data.services || []);
      onDetected(detected);
    } catch (e) {
      setError('Could not detect services. You can skip this step.');
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
            Let's get your self-hosted ecosystem set up. We'll scan for existing services on your network and recommend open-source alternatives you
            can install with one click.
          </p>
        </div>

        <div className="flex flex-col gap-3 items-center">
          <Button intent="primary" onClick={handleDetect} loading={loading} disabled={loading} className="w-64">
            Scan for existing services
          </Button>
          <Button variant="ghost" onClick={onSkip} disabled={loading}>
            Skip — I'll browse the store myself
          </Button>
        </div>

        {error && <p className="text-sm text-destructive mt-4">{error}</p>}
      </CardContent>
    </Card>
  );
};
