import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useState } from 'react';
import type { OnboardingApp } from '../helpers/types';

interface SelectAppsStepProps {
  selectedApps: OnboardingApp[];
  onConfirm: (apps: OnboardingApp[]) => void;
  onBack: () => void;
}

export const SelectAppsStep = ({ selectedApps, onConfirm, onBack }: SelectAppsStepProps) => {
  const [apps, setApps] = useState<OnboardingApp[]>(selectedApps);

  const removeApp = (slug: string) => {
    setApps((prev) => prev.filter((a) => a.appSlug !== slug));
  };

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">Review Your Selection</h2>
          <p className="text-sm text-muted-foreground">
            {apps.length > 0
              ? `${apps.length} app${apps.length !== 1 ? 's' : ''} selected for installation. Remove any you don't need.`
              : 'No apps selected.'}
          </p>
        </div>

        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
          {apps.map((app) => (
            <div key={app.appSlug} className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
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
                {app.replacesNames.length > 0 && <div className="text-xs text-muted-foreground">Replaces {app.replacesNames.join(', ')}</div>}
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeApp(app.appSlug)} className="text-destructive hover:text-destructive">
                ✕
              </Button>
            </div>
          ))}

          {apps.length === 0 && (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">📦</div>
              <p className="text-muted-foreground">No apps selected. Go back to add some, or finish setup.</p>
            </div>
          )}
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
