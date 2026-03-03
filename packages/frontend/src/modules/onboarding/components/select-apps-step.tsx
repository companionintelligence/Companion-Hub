import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useState } from 'react';
import type { OnboardingApp } from '../helpers/types';

interface SelectAppsStepProps {
  selectedApps: OnboardingApp[];
  onConfirm: (apps: OnboardingApp[]) => void;
  onBack: () => void;
}

export const SelectAppsStep = ({ selectedApps, onConfirm, onBack }: SelectAppsStepProps) => {
  const [apps, setApps] = useState<OnboardingApp[]>(selectedApps);

  const updateSubdomain = (slug: string, subdomain: string) => {
    setApps((prev) => prev.map((a) => (a.appSlug === slug ? { ...a, localSubdomain: subdomain } : a)));
  };

  const removeApp = (slug: string) => {
    setApps((prev) => prev.filter((a) => a.appSlug !== slug));
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">Configure Your Apps</h2>
          <p className="text-sm text-muted-foreground">Review your selections and optionally set local subdomains for each app.</p>
        </div>

        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
          {apps.map((app) => (
            <div key={app.appSlug} className="flex items-center gap-3 p-3 rounded-lg border">
              <img
                src={app.icon}
                alt=""
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{app.name}</div>
                <div className="text-xs text-muted-foreground">{app.urn ? `URN: ${app.urn}` : `Slug: ${app.appSlug}`}</div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={app.localSubdomain || ''}
                  onChange={(e) => updateSubdomain(app.appSlug, e.target.value)}
                  placeholder="subdomain"
                  className="w-32 text-xs"
                />
                <Button variant="ghost" size="sm" onClick={() => removeApp(app.appSlug)} className="text-destructive">
                  ✕
                </Button>
              </div>
            </div>
          ))}

          {apps.length === 0 && <p className="text-center text-muted-foreground py-8">No apps selected. Go back to add some.</p>}
        </div>

        <div className="flex justify-between mt-6">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button intent="primary" onClick={() => onConfirm(apps)}>
            {apps.length > 0 ? `Install ${apps.length} app${apps.length !== 1 ? 's' : ''}` : 'Finish setup'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
