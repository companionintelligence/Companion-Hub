import { apiFetch } from '@/lib/api-fetch';
import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { ArrowUpCircle, Loader2, Star, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { checkForUpdates, isHubUpdateAvailable, isTauri, performStackUpdate, performUpdate, type UpdateInfo } from '@/lib/update-service';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version, refreshAppContext } = useAppContext();

  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [autoUpdatesLoading, setAutoUpdatesLoading] = useState(false);
  const [restartingWizard, setRestartingWizard] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<UpdateInfo | null>(null);

  const handleRestartWizard = useCallback(async () => {
    setRestartingWizard(true);
    try {
      const res = await apiFetch('/api/restart-onboarding', { method: 'PATCH', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = '/onboarding';
    } catch {
      setRestartingWizard(false);
      toast.error(t('SETTINGS_WIZARD_RESTART_ERROR'));
    }
  }, [t]);

  const refreshUpdateState = useCallback(async () => {
    if (!isTauri()) {
      setDesktopUpdate(null);
      return null;
    }
    const info = await checkForUpdates(version.current);
    setDesktopUpdate(info);
    return info;
  }, [version.current]);

  useEffect(() => {
    if (!isTauri()) return;
    void refreshUpdateState();
  }, [refreshUpdateState]);

  useEffect(() => {
    apiFetch('/api/system/update/auto-updates', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => setAutoUpdates(data.enabled))
      .catch(() => {
        // Best-effort load; keep the default toggle state if unavailable.
      });
  }, []);

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true);
    setUpdateMessage(null);
    try {
      if (isTauri()) {
        const info = await refreshUpdateState();
        if (info?.updateAvailable) {
          toast.success(t('SETTINGS_ACTIONS_UPDATE_AVAILABLE', { version: info.latestVersion }));
        } else {
          toast.success(t('SETTINGS_ACTIONS_ON_LATEST_VERSION'));
        }
        return;
      }

      const res = await apiFetch('/api/system/update/check', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { updateAvailable?: boolean; latest?: string };
      await refreshAppContext();
      if (data.updateAvailable) {
        toast.success(t('SETTINGS_ACTIONS_UPDATE_AVAILABLE', { version: data.latest ?? version.latest }));
      } else {
        toast.success(t('SETTINGS_ACTIONS_ON_LATEST_VERSION'));
      }
    } catch {
      toast.error(t('SETTINGS_ACTIONS_CHECK_UPDATE_FAILED'));
    } finally {
      setChecking(false);
    }
  }, [refreshAppContext, refreshUpdateState, t, version.latest]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      if (isTauri()) {
        const info = desktopUpdate ?? (await refreshUpdateState());
        if (info?.updateAvailable) {
          const result = await performUpdate(info);
          if (result.ok) {
            const message = t(result.messageKey, result.messageParams);
            setUpdateMessage(message);
            toast.success(message);
          } else {
            const message = t(result.messageKey, result.messageParams);
            setUpdateMessage(message);
            toast.error(message);
            setUpdating(false);
          }
          return;
        }
      }

      const stackResult = await performStackUpdate(version.latest);
      if (stackResult.ok) {
        const message = t(stackResult.messageKey, stackResult.messageParams);
        setUpdateMessage(message);
        setTimeout(() => window.location.reload(), 15000);
      } else {
        setUpdateMessage(t(stackResult.messageKey, stackResult.messageParams));
        setUpdating(false);
      }
    } catch {
      setUpdateMessage(t('SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED'));
      setUpdating(false);
    }
  }, [desktopUpdate, refreshUpdateState, t, version.latest]);

  const handleAutoUpdatesToggle = useCallback(async () => {
    setAutoUpdatesLoading(true);
    const newValue = !autoUpdates;
    try {
      await apiFetch('/api/system/update/auto-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: newValue }),
      });
      setAutoUpdates(newValue);
    } catch {
      // ignore
    }
    setAutoUpdatesLoading(false);
  }, [autoUpdates]);

  const updateAvailable = isHubUpdateAvailable(isTauri(), desktopUpdate, version.current, version.latest);
  const displayVersion = desktopUpdate?.currentVersion ?? version.current;
  const latestVersion = desktopUpdate?.latestVersion ?? version.latest;

  const renderUpdateButton = () => {
    if (updateMessage) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm">
          {updating && <Loader2 className="h-4 w-4 animate-spin" />}
          {updateMessage}
        </div>
      );
    }

    if (updateAvailable) {
      return (
        <div>
          <Button onClick={handleUpdate} disabled={updating} className="mb-4" data-testid="hub-update-btn">
            {updating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('SETTINGS_ACTIONS_UPDATING')}
              </>
            ) : (
              t('SETTINGS_ACTIONS_UPDATE_TO_VERSION', { version: latestVersion })
            )}
          </Button>
          {version.releases?.map((release) => (
            <Card key={release.version} className="mt-3 relative overflow-hidden w-full md:w-2/3">
              <div className="absolute -right-6 -top-6 text-yellow-500 opacity-20 rotate-12 pointer-events-none">
                <Star size={80} fill="currentColor" />
              </div>
              <CardHeader>
                <CardTitle>{t('SETTINGS_ACTIONS_VERSION_LABEL', { version: release.version })}</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown className="" content={release.body} />
              </CardContent>
            </Card>
          ))}
        </div>
      );
    }

    return (
      <Button onClick={handleCheckForUpdates} disabled={checking} variant="outline" data-testid="hub-check-updates-btn">
        {checking ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {t('SETTINGS_ACTIONS_CHECKING')}
          </>
        ) : (
          t('SETTINGS_ACTIONS_CHECK_FOR_UPDATES')
        )}
      </Button>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('COMMON_ACTIONS')}</CardTitle>
          </div>
          <CardDescription>
            {t('SETTINGS_ACTIONS_CURRENT_VERSION', { version: displayVersion })}
            {isTauri() ? '' : t('SETTINGS_ACTIONS_STACK_SUFFIX')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {updateAvailable ? t('SETTINGS_ACTIONS_NEW_VERSION', { version: latestVersion }) : t('SETTINGS_ACTIONS_STAY_UP_TO_DATE')}
          </p>
          {renderUpdateButton()}

          <div className="mt-6 pt-6 border-t">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">{t('SETTINGS_ACTIONS_AUTO_UPDATE_STACK_TITLE')}</h3>
                <p className="text-sm text-muted-foreground">{t('SETTINGS_ACTIONS_AUTO_UPDATE_STACK_DESCRIPTION')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoUpdates}
                onClick={handleAutoUpdatesToggle}
                disabled={autoUpdatesLoading}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoUpdates ? 'bg-primary' : 'bg-input'} ${autoUpdatesLoading ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${autoUpdates ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t">
            <h3 className="text-lg font-semibold mb-1">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</h3>
            <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')}</p>
            <UpdateRepoModal />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_WIZARD_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_WIZARD_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleRestartWizard} disabled={restartingWizard} data-testid="restart-wizard-btn">
            {restartingWizard ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('SETTINGS_WIZARD_RESTARTING')}
              </>
            ) : (
              t('SETTINGS_WIZARD_RESTART_BUTTON')
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
