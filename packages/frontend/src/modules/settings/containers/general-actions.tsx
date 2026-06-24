import { apiFetch } from '@/lib/api-fetch';
import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { ArrowUpCircle, Loader2, Star, TriangleAlert, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  checkForUpdates,
  getInstalledDesktopVersion,
  isHubUpdateAvailable,
  isTauri,
  performStackUpdate,
  performUpdate,
  type UpdateActionResult,
  type UpdateInfo,
} from '@/lib/update-service';

const FACTORY_RESET_CONFIRMATION = 'factory-reset';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version, refreshAppContext } = useAppContext();

  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [autoUpdatesLoading, setAutoUpdatesLoading] = useState(false);
  const [restartingWizard, setRestartingWizard] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [factoryResetPhrase, setFactoryResetPhrase] = useState('');
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<UpdateInfo | null>(null);
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);

  const desktop = isTauri();

  const getUpdateMessage = useCallback(
    (result: UpdateActionResult) =>
      result.defaultMessage
        ? t(result.messageKey, { defaultValue: result.defaultMessage, ...result.messageParams })
        : t(result.messageKey, result.messageParams),
    [t],
  );

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

  const handleFactoryReset = useCallback(async () => {
    if (factoryResetPhrase.trim() !== FACTORY_RESET_CONFIRMATION) {
      toast.error(t('SETTINGS_FACTORY_RESET_CONFIRMATION_MISMATCH'));
      return;
    }

    setFactoryResetting(true);
    try {
      const res = await apiFetch('/api/system/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: FACTORY_RESET_CONFIRMATION }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(t('SETTINGS_FACTORY_RESET_SUCCESS'));
      window.location.href = '/login';
    } catch {
      setFactoryResetting(false);
      toast.error(t('SETTINGS_FACTORY_RESET_ERROR'));
    }
  }, [factoryResetPhrase, t]);

  const refreshUpdateState = useCallback(async () => {
    if (!desktop) {
      setDesktopUpdate(null);
      setDesktopVersion(null);
      return null;
    }

    const installedVersion = await getInstalledDesktopVersion();
    setDesktopVersion(installedVersion);
    if (!installedVersion) {
      setDesktopUpdate(null);
      return null;
    }

    const info = await checkForUpdates(installedVersion);
    setDesktopUpdate(info);
    return info;
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void refreshUpdateState();
  }, [desktop, refreshUpdateState]);

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
      if (desktop) {
        const info = await refreshUpdateState();
        if (!info) {
          toast.error(t('SETTINGS_ACTIONS_CHECK_UPDATE_FAILED'));
        } else if (info.updateAvailable) {
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
  }, [desktop, refreshAppContext, refreshUpdateState, t, version.latest]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateMessage(null);
    try {
      if (desktop) {
        const info = desktopUpdate ?? (await refreshUpdateState());
        if (info?.updateAvailable) {
          const result = await performUpdate(info);
          const message = getUpdateMessage(result);
          if (result.ok) {
            setUpdateMessage(message);
            toast.success(message);
          } else {
            setUpdateMessage(message);
            toast.error(message);
            setUpdating(false);
          }
          return;
        }
      }

      const stackResult = await performStackUpdate(version.latest);
      if (stackResult.ok) {
        const message = getUpdateMessage(stackResult);
        setUpdateMessage(message);
        setTimeout(() => window.location.reload(), 15000);
      } else {
        setUpdateMessage(getUpdateMessage(stackResult));
        setUpdating(false);
      }
    } catch {
      setUpdateMessage(t('SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED'));
      setUpdating(false);
    }
  }, [desktop, desktopUpdate, getUpdateMessage, refreshUpdateState, t, version.latest]);

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

  const updateAvailable = isHubUpdateAvailable(desktop, desktopUpdate, version.current, version.latest);
  const displayVersion = desktop ? (desktopVersion ?? t('COMMON_UNKNOWN')) : version.current;
  const latestVersion = desktop ? (desktopUpdate?.latestVersion ?? displayVersion) : version.latest;

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
            ) : desktopUpdate?.manualDownload ? (
              t('SETTINGS_ACTIONS_DOWNLOAD_INSTALLER', 'Download installer')
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
            {desktop ? '' : t('SETTINGS_ACTIONS_STACK_SUFFIX')}
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

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-destructive" />
            <CardTitle className="text-xl">{t('SETTINGS_FACTORY_RESET_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_FACTORY_RESET_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{t('SETTINGS_FACTORY_RESET_DESCRIPTION')}</p>
          <Button intent="danger" variant="outline" onClick={() => setFactoryResetOpen(true)} data-testid="factory-reset-btn">
            {t('SETTINGS_FACTORY_RESET_BUTTON')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={factoryResetOpen} onOpenChange={setFactoryResetOpen}>
        <DialogContent type="danger" size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_FACTORY_RESET_DIALOG_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="space-y-4 py-2">
            <p>{t('SETTINGS_FACTORY_RESET_DIALOG_BODY')}</p>
            <div className="space-y-2 text-left">
              <label htmlFor="factory-reset-confirmation" className="text-sm font-medium">
                {t('SETTINGS_FACTORY_RESET_CONFIRMATION_LABEL', { phrase: FACTORY_RESET_CONFIRMATION })}
              </label>
              <Input
                id="factory-reset-confirmation"
                value={factoryResetPhrase}
                onChange={(event) => setFactoryResetPhrase(event.target.value)}
                autoComplete="off"
                data-testid="factory-reset-confirmation-input"
              />
            </div>
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFactoryResetOpen(false)} disabled={factoryResetting}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              intent="danger"
              loading={factoryResetting}
              disabled={factoryResetPhrase.trim() !== FACTORY_RESET_CONFIRMATION}
              onClick={handleFactoryReset}
              data-testid="factory-reset-confirm-btn"
            >
              {t('SETTINGS_FACTORY_RESET_BUTTON')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
