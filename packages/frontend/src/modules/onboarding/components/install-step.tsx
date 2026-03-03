import { Card, CardContent } from '@/components/ui/Card';
import { useEffect, useState } from 'react';
import type { OnboardingApp } from '../helpers/types';

interface InstallStepProps {
  apps: OnboardingApp[];
  onComplete: () => void;
}

type InstallStatus = 'pending' | 'installing' | 'success' | 'error';

interface AppInstallState {
  app: OnboardingApp;
  status: InstallStatus;
  error?: string;
}

export const InstallStep = ({ apps, onComplete }: InstallStepProps) => {
  const [states, setStates] = useState<AppInstallState[]>(apps.map((app) => ({ app, status: 'pending' })));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done || apps.length === 0) return;

    const installNext = async (index: number) => {
      if (index >= apps.length) {
        setDone(true);
        // Wait a beat so user sees the final state
        setTimeout(onComplete, 1500);
        return;
      }

      const app = apps[index];
      if (!app) return;
      if (!app.urn) {
        // Skip apps without a valid URN
        setStates((prev) => prev.map((s, i) => (i === index ? { ...s, status: 'error', error: 'Not available in store' } : s)));
        setCurrentIndex(index + 1);
        return;
      }

      setStates((prev) => prev.map((s, i) => (i === index ? { ...s, status: 'installing' } : s)));

      try {
        const res = await fetch(`/api/app-lifecycle/${encodeURIComponent(app.urn)}/install`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localSubdomain: app.localSubdomain || app.appSlug,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${res.status}`);
        }

        setStates((prev) => prev.map((s, i) => (i === index ? { ...s, status: 'success' } : s)));
      } catch (e) {
        setStates((prev) => prev.map((s, i) => (i === index ? { ...s, status: 'error', error: (e as Error).message } : s)));
      }

      setCurrentIndex(index + 1);
    };

    installNext(currentIndex);
  }, [currentIndex, done, apps, onComplete]);

  const statusIcon = (status: InstallStatus) => {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'installing':
        return '⚙️';
      case 'success':
        return '✅';
      case 'error':
        return '❌';
    }
  };

  const completedCount = states.filter((s) => s.status === 'success').length;
  const errorCount = states.filter((s) => s.status === 'error').length;
  const progress = apps.length > 0 ? Math.round(((completedCount + errorCount) / apps.length) * 100) : 0;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">Installing Apps</h2>
          <p className="text-sm text-muted-foreground">
            {done ? `Done! ${completedCount} installed, ${errorCount} failed.` : `Installing ${currentIndex + 1} of ${apps.length}...`}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-muted rounded-full h-2 mb-4">
          <div className="bg-primary h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
          {states.map((state) => (
            <div key={state.app.appSlug} className="flex items-center gap-3 p-2 rounded-lg">
              <span className="text-lg">{statusIcon(state.status)}</span>
              <img
                src={state.app.icon}
                alt=""
                className="w-6 h-6 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{state.app.name}</div>
                {state.error && <div className="text-xs text-destructive">{state.error}</div>}
              </div>
              {state.status === 'installing' && <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
