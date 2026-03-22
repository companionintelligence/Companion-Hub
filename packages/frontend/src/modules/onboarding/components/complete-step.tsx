import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
import { useNavigate } from 'react-router';

interface CompleteStepProps {
  installed: boolean;
}

export const CompleteStep = ({ installed }: CompleteStepProps) => {
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [loading, setLoading] = useState(false);

  const handleFinish = async () => {
    setLoading(true);
    try {
      await fetch('/api/complete-onboarding', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      await refreshAppContext();
      navigate('/dashboard', { replace: true });
    } catch {
      // Even if the API call fails, navigate to dashboard
      navigate('/dashboard', { replace: true });
    }
  };

  return (
    <Card>
      <CardContent className="p-8 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-xl font-semibold mb-2">You're All Set!</h2>
        <p className="text-muted-foreground max-w-md mx-auto mb-6">
          {installed
            ? "Your apps are being installed in the background. They'll be ready shortly on your dashboard."
            : 'Your Hub is ready to go. You can install apps anytime from the App Store.'}
        </p>
        <Button intent="primary" onClick={handleFinish} loading={loading} disabled={loading} className="w-64">
          Go to Dashboard
        </Button>
      </CardContent>
    </Card>
  );
};
