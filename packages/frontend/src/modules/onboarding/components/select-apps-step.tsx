import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import { Package, X } from 'lucide-react';
import type { OnboardingApp } from '../helpers/types';
import { OnboardingAppIcon } from './onboarding-app-icon';
import { WizardCard, WizardHeader, WizardNav } from './wizard-ui';
import { useTranslation } from 'react-i18next';

interface SelectAppsStepProps {
  selectedApps: OnboardingApp[];
  onConfirm: (apps: OnboardingApp[]) => void;
  onBack: () => void;
}

export const SelectAppsStep = ({ selectedApps, onConfirm, onBack }: SelectAppsStepProps) => {
  const { t } = useTranslation();
  const [apps, setApps] = useState<OnboardingApp[]>(selectedApps);

  useEffect(() => {
    setApps(selectedApps);
  }, [selectedApps]);

  const removeApp = (slug: string) => {
    setApps((prev) => prev.filter((a) => a.appSlug !== slug));
  };

  return (
    <WizardCard>
      <WizardHeader
        icon={<Package />}
        title={t('ONBOARDING_REVIEW_SELECTION')}
        description={apps.length > 0 ? t('ONBOARDING_APPS_SELECTED_FOR_INSTALL', { count: apps.length }) : t('ONBOARDING_NO_APPS_SELECTED_SHORT')}
      />

      <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2">
        {apps.map((app) => (
          <div
            key={app.appSlug}
            className="flex items-center gap-3 rounded-md border border-border bg-foreground/[0.015] p-3 transition-colors hover:border-primary/40"
          >
            <OnboardingAppIcon app={app} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{app.name}</div>
              {app.replacesNames.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  {t('ONBOARDING_REPLACES')} {app.replacesNames.join(', ')}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeApp(app.appSlug)}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`${t('COMMON_REMOVE')} ${app.name}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

        {apps.length === 0 && (
          <div className="flex flex-col items-center py-10 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-md border border-border bg-foreground/[0.02] text-muted-foreground">
              <Package className="h-6 w-6" />
            </span>
            <p className="mt-3 text-sm text-muted-foreground">{t('ONBOARDING_NO_APPS_SELECTED_DESC')}</p>
          </div>
        )}
      </div>

      <WizardNav>
        <Button variant="ghost" onClick={onBack}>
          {t('COMMON_BACK')}
        </Button>
        <Button intent="primary" onClick={() => onConfirm(apps)}>
          {t('ONBOARDING_CONTINUE_TO_INSTALL')}
        </Button>
      </WizardNav>
    </WizardCard>
  );
};
