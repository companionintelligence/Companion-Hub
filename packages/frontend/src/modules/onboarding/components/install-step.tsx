import { Card, CardContent } from '@/components/ui/Card';
import { useEffect, useRef, useState } from 'react';
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
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (started.current || apps.length === 0) return;
    started.current = true;

    const installAll = async () => {
      const minDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        if (!app) continue;

        if (!app.urn) {
          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'error', error: 'Not available in store' } : s)));
          await minDelay(500);
          continue;
        }

        setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'installing' } : s)));

        try {
          const [res] = await Promise.all([
            fetch(`/api/app-lifecycle/${encodeURIComponent(app.urn)}/install`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                localSubdomain: app.localSubdomain || app.appSlug,
              }),
            }),
            minDelay(800),
          ]);

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || `HTTP ${res.status}`);
          }

          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'success' } : s)));
        } catch (e) {
          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'error', error: (e as Error).message } : s)));
        }
      }

      setDone(true);
      setTimeout(() => onCompleteRef.current(), 3000);
    };

    installAll();
  }, [apps]);

  const statusIcon = (status: InstallStatus) => {
    switch (status) {
      case 'pending':
        return <span className="text-muted-foreground">○</span>;
      case 'installing':
        return <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />;
      case 'success':
        return <span className="text-green-500">✓</span>;
      case 'error':
        return <span className="text-destructive">✕</span>;
    }
  };

  const completedCount = states.filter((s) => s.status === 'success').length;
  const errorCount = states.filter((s) => s.status === 'error').length;
  const processedCount = completedCount + errorCount;
  const progress = apps.length > 0 ? Math.round((processedCount / apps.length) * 100) : 0;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">{done ? 'Installation Complete' : 'Installing Apps'}</h2>
          <p className="text-sm text-muted-foreground">
            {done
              ? `${completedCount} installed${errorCount > 0 ? `, ${errorCount} failed` : ''}.`
              : `Installing ${processedCount + 1} of ${apps.length}...`}
          </p>
        </div>

        <div className="w-full bg-muted rounded-full h-2 mb-4 overflow-hidden">
          <div className="bg-primary h-2 rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        <div className="space-y-1 max-h-[350px] overflow-y-auto pr-2">
          {states.map((state) => (
            <div key={state.app.appSlug} className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors">
              <span className="w-5 h-5 flex items-center justify-center text-sm font-semibold">{statusIcon(state.status)}</span>
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
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
