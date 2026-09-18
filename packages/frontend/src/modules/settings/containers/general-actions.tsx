import {
  checkForUpdates as checkHubForUpdates,
  getAutoUpdates,
  restartOnboarding,
  setAutoUpdates as updateAutoUpdatesSetting,
} from '@/api-client/sdk.gen';
import { factoryReset } from '@/api-client/sdk.gen';
import { sdkResult, unwrapSdkOrNull } from '@/lib/sdk-unwrap';
import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { ArrowUpCircle, Loader2, Smartphone, Star, TriangleAlert, Wand2 } from 'lucide-react';
import { clearHubConnection, getHubBaseUrlSync, usesCloudConnect } from '@/lib/mobile-connection';
import { useTranslation } from 'react-i18next';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';
import { useState, useEffect, useCallback } from 'react';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import {
  clearHubSteadySession,
  clearStackUpdatePending,
  isStackUpdatePending,
  markStackUpdatePending,
  subscribeStackUpdate,
} from '@/lib/desktop-stack-session';
import toast from 'react-hot-toast';
import {
  checkForUpdates,
  fetchHostListenerStatus,
  getInstalledDesktopVersion,
  isStackUpdateAvailable,
  isTauri,
  manualUpdateArtifactKind,
  performStackUpdate,
  performUpdate,
  type UpdateActionResult,
  type UpdateInfo,
} from '@/lib/update-service';

const FACTORY_RESET_CONFIRMATION = 'factory-reset';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version, refreshAppContext } = useAppContext();
  const demoMode = useDemoMode();

  // A stack update outlives this component: the request returns in a second, the Hub is
  // recreated over the next minute, and the user may switch tabs in between. The pending
  // marker in sessionStorage is the source of truth; `hub_hello` on the app SSE stream
  // resolves it (see `lib/hub-hello.ts`) and the subscription below turns that into UI.
  const [updating, setUpdating] = useState<boolean>(() => isStackUpdatePending());
  const [checking, setChecking] = useState(false);
  const [stackMessage, setStackMessage] = useState<string | null>(() => (isStackUpdatePending() ? t('SETTINGS_ACTIONS_UPDATE_RESTARTING') : null));
  const [shellMessage, setShellMessage] = useState<string | null>(null);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [autoUpdatesLoading, setAutoUpdatesLoading] = useState(false);
  const [restartingWizard, setRestartingWizard] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [factoryResetPhrase, setFactoryResetPhrase] = useState('');
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [shellUpdate, setShellUpdate] = useState<UpdateInfo | null>(null);
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  const [updatingShell, setUpdatingShell] = useState(false);
  const [hostListenerReachable, setHostListenerReachable] = useState<boolean | null>(null);
  const [switchHubOpen, setSwitchHubOpen] = useState(false);

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
      const result = await sdkResult(restartOnboarding());
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      window.location.href = '/onboarding';
    } catch {
      setRestartingWizard(false);
      toast.error(t('SETTINGS_WIZARD_RESTART_ERROR'));
    }
  }, [t]);

  const handleFactoryReset = useCallback(async () => {
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }
    if (factoryResetPhrase.trim() !== FACTORY_RESET_CONFIRMATION) {
      toast.error(t('SETTINGS_FACTORY_RESET_CONFIRMATION_MISMATCH'));
      return;
    }

    setFactoryResetting(true);
    try {
      const result = await factoryReset({ body: { confirmation: FACTORY_RESET_CONFIRMATION } });
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      clearClientHubState();
      toast.success(t('SETTINGS_FACTORY_RESET_SUCCESS'));
      window.location.href = '/login';
    } catch {
      setFactoryResetting(false);
      toast.error(t('SETTINGS_FACTORY_RESET_ERROR'));
    }
  }, [demoMode, factoryResetPhrase, t]);

  const refreshShellUpdateState = useCallback(async () => {
    const installedVersion = desktop ? await getInstalledDesktopVersion() : null;
    setShellVersion(installedVersion);
    const info = await checkForUpdates(installedVersion ?? undefined);
    setShellUpdate(info);
    return info;
  }, [desktop]);

  const refreshHostListenerStatus = useCallback(async () => {
    const reachable = await fetchHostListenerStatus();
    setHostListenerReachable(reachable);
    return reachable;
  }, []);

  useEffect(() => {
    void refreshShellUpdateState();
  }, [refreshShellUpdateState]);

  useEffect(
    () =>
      subscribeStackUpdate((outcome) => {
        setUpdating(false);
        setStackMessage(
          outcome.state === 'completed'
            ? t('SETTINGS_ACTIONS_UPDATE_COMPLETE', { version: outcome.version })
            : t('SETTINGS_ACTIONS_UPDATE_NOT_CONFIRMED', { version: outcome.version }),
        );
        void refreshAppContext();
      }),
    [refreshAppContext, t],
  );

  const handleStopWaiting = useCallback(() => {
    clearStackUpdatePending();
    setUpdating(false);
    setStackMessage(null);
  }, []);

  useEffect(() => {
    void refreshHostListenerStatus();
  }, [refreshHostListenerStatus]);

  useEffect(() => {
    void unwrapSdkOrNull(getAutoUpdates()).then((data) => {
      const enabled = (data as { enabled?: boolean } | null)?.enabled;
      if (typeof enabled === 'boolean') setAutoUpdates(enabled);
    });
  }, []);

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true);
    setStackMessage(null);
    try {
      const result = await sdkResult(checkHubForUpdates());
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const data = (result.data ?? {}) as { updateAvailable?: boolean; latest?: string };
      await refreshAppContext();
      await refreshShellUpdateState();
      await refreshHostListenerStatus();
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
  }, [refreshAppContext, refreshHostListenerStatus, refreshShellUpdateState, t, version.latest]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setStackMessage(null);
    try {
      const stackResult = await performStackUpdate(version.latest);
      if (stackResult.ok) {
        markStackUpdatePending(version.current);
        clearHubSteadySession();
        setStackMessage(getUpdateMessage(stackResult));
      } else {
        setStackMessage(getUpdateMessage(stackResult));
        setUpdating(false);
      }
    } catch {
      setStackMessage(t('SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED'));
      setUpdating(false);
    }
  }, [getUpdateMessage, t, version.latest, version.current]);

  const handleShellUpdate = useCallback(async () => {
    setUpdatingShell(true);
    setShellMessage(null);
    try {
      const info = shellUpdate ?? (await refreshShellUpdateState());
      if (!info?.downloadUrl) {
        const message = t('SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL');
        setShellMessage(message);
        toast.error(message);
        return;
      }

      const result = await performUpdate(info);
      const message = getUpdateMessage(result);
      setShellMessage(message);
      if (result.ok) {
        toast.success(message);
      } else {
        toast.error(message);
      }
    } catch {
      setShellMessage(t('SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED'));
    } finally {
      setUpdatingShell(false);
    }
  }, [getUpdateMessage, refreshShellUpdateState, shellUpdate, t]);

  const handleAutoUpdatesToggle = useCallback(async () => {
    setAutoUpdatesLoading(true);
    const newValue = !autoUpdates;
    try {
      const result = await sdkResult(updateAutoUpdatesSetting({ body: { enabled: newValue } }));
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      setAutoUpdates(newValue);
    } catch {
      // ignore
    }
    setAutoUpdatesLoading(false);
  }, [autoUpdates]);

  const stackUpdateAvailable = isStackUpdateAvailable(version.current, version.latest);
  const displayVersion = version.current || t('COMMON_UNKNOWN');
  const latestVersion = version.latest;

  /**
   * The desktop button only downloads an installer. Spell out the remaining
   * steps for this computer's package format, including Linux apt/rpm.
   */
  const renderManualUpdateInstructions = () => {
    if (!shellUpdate?.downloadUrl) {
      return null;
    }

    const kind = manualUpdateArtifactKind(shellUpdate.downloadUrl);
    const platform = shellUpdate.platform;
    let steps: { text: string; command?: string }[] | null = null;

    if (kind === 'appimage') {
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        {
          text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_APPIMAGE_STEP_REPLACE'),
          command: 'chmod +x ~/Downloads/Companion.Hub_*.AppImage',
        },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_RELAUNCH') },
      ];
    } else if (kind === 'deb' || kind === 'rpm') {
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        {
          text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_REMOVE'),
          command: kind === 'deb' ? 'sudo apt purge companion-hub -y' : 'sudo rpm -e companion-hub',
        },
        {
          text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_INSTALL'),
          command: kind === 'deb' ? 'sudo apt install ./companion-hub_*.deb' : 'sudo rpm -U ./companion-hub-*.rpm',
        },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_RELAUNCH') },
      ];
    } else if (kind === 'dmg' || platform === 'macos') {
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_MACOS_STEP_OPEN') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_RELAUNCH') },
      ];
    } else if (kind === 'exe' || kind === 'msi' || platform === 'windows') {
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_WINDOWS_STEP_QUIT') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_WINDOWS_STEP_RUN') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_RELAUNCH') },
      ];
    }

    if (!steps) return null;

    return (
      <Card className="mt-4 w-full max-w-md" data-testid="manual-update-instructions">
        <CardHeader className="p-3 pb-1">
          <CardTitle className="text-base">{t('SETTINGS_ACTIONS_MANUAL_UPDATE_TITLE')}</CardTitle>
          <CardDescription>{t('SETTINGS_ACTIONS_MANUAL_UPDATE_INTRO')}</CardDescription>
        </CardHeader>
        <CardContent className="p-3 pt-1">
          <ol className="list-decimal list-inside space-y-2 text-sm">
            {steps.map((step) => (
              <li key={step.text}>
                {step.text}
                {step.command ? <code className="mt-1 block select-all rounded bg-muted px-2 py-1 font-mono text-xs">{step.command}</code> : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    );
  };

  const renderUpdateButton = () => {
    if (stackMessage) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm" data-testid="hub-update-status">
          {updating && <Loader2 className="h-4 w-4 animate-spin" />}
          <span className="flex-1">{stackMessage}</span>
          {updating && (
            <Button variant="ghost" size="sm" onClick={handleStopWaiting} data-testid="hub-update-stop-waiting">
              {t('SETTINGS_ACTIONS_UPDATE_STOP_WAITING')}
            </Button>
          )}
        </div>
      );
    }

    if (stackUpdateAvailable) {
      const release = version.releases?.find((r) => r.version === latestVersion) ?? version.releases?.[0];
      const releaseBody = release?.body?.trim() ?? '';
      // Backend currently stubs body as "Release <version>"; skip that redundancy.
      const showBody = Boolean(releaseBody) && releaseBody !== `Release ${release?.version}`;

      return (
        <div>
          <Button onClick={handleUpdate} disabled={updating} className="mb-4" data-testid="hub-update-btn">
            {updating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('SETTINGS_ACTIONS_STACK_UPDATING')}
              </>
            ) : (
              t('SETTINGS_ACTIONS_UPDATE_STACK_TO_VERSION', { version: latestVersion })
            )}
          </Button>
          {release ? (
            <Card className="mt-3 relative overflow-hidden w-full max-w-md" data-testid="hub-latest-release-card">
              <div className="absolute -right-3 -top-3 text-yellow-500 opacity-20 rotate-12 pointer-events-none">
                <Star size={40} fill="currentColor" />
              </div>
              <CardHeader className={showBody ? 'p-3 pb-2' : 'p-3'}>
                <CardTitle className="text-base">{t('SETTINGS_ACTIONS_VERSION_LABEL', { version: release.version })}</CardTitle>
              </CardHeader>
              {showBody ? (
                <CardContent className="p-3 pt-0">
                  <Markdown className="text-sm prose-sm" content={release.body} />
                </CardContent>
              ) : null}
            </Card>
          ) : null}
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
            <ArrowUpCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_ACTIONS_HUB_STACK_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_ACTIONS_CURRENT_VERSION', { version: displayVersion })}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {stackUpdateAvailable ? t('SETTINGS_ACTIONS_NEW_VERSION', { version: latestVersion }) : t('SETTINGS_ACTIONS_STAY_UP_TO_DATE')}
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
        </CardContent>
      </Card>

      <Card data-testid="desktop-shell-update-card">
        <CardHeader>
          <CardTitle className="text-xl">{t('SETTINGS_ACTIONS_SHELL_UPDATE_TITLE')}</CardTitle>
          <CardDescription>
            {shellVersion
              ? t('SETTINGS_ACTIONS_SHELL_UPDATE_SUBTITLE_WITH_VERSION', { version: shellVersion })
              : t('SETTINGS_ACTIONS_SHELL_UPDATE_SUBTITLE')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hostListenerReachable === false ? (
            <p className="text-sm text-muted-foreground mb-4" data-testid="host-listener-unavailable">
              {t('SETTINGS_ACTIONS_HOST_LISTENER_UNAVAILABLE')}
            </p>
          ) : null}
          {hostListenerReachable === true ? (
            <p className="text-sm text-muted-foreground mb-4" data-testid="host-listener-ready">
              {t('SETTINGS_ACTIONS_HOST_LISTENER_READY')}
            </p>
          ) : null}
          {shellUpdate?.downloadUrl ? (
            <>
              {shellVersion && !shellUpdate.updateAvailable ? (
                <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_ACTIONS_SHELL_UP_TO_DATE')}</p>
              ) : null}
              <Button onClick={handleShellUpdate} disabled={updatingShell} data-testid="hub-shell-update-btn">
                {updatingShell ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('SETTINGS_ACTIONS_CHECKING')}
                  </>
                ) : (
                  t('SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_VERSION', { version: shellUpdate.latestVersion })
                )}
              </Button>
              {shellMessage ? <p className="mt-3 text-sm text-muted-foreground">{shellMessage}</p> : null}
              {renderManualUpdateInstructions()}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {shellVersion && !shellUpdate?.updateAvailable ? t('SETTINGS_ACTIONS_SHELL_UP_TO_DATE') : t('SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</CardTitle>
          <CardDescription>{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UpdateRepoModal />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CardTitle className="text-xl">{t('SETTINGS_WIZARD_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_WIZARD_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleRestartWizard} disabled={demoMode || restartingWizard} data-testid="restart-wizard-btn">
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
            <TriangleAlert className="h-5 w-5 shrink-0 text-destructive" />
            <CardTitle className="text-xl">{t('SETTINGS_FACTORY_RESET_TITLE')}</CardTitle>
          </div>
          <CardDescription>{t('SETTINGS_FACTORY_RESET_SUBTITLE')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{t('SETTINGS_FACTORY_RESET_DESCRIPTION')}</p>
          <Button intent="danger" variant="outline" disabled={demoMode} onClick={() => setFactoryResetOpen(true)} data-testid="factory-reset-btn">
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

      {usesCloudConnect() && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" />
              <CardTitle className="text-xl">{t('MOBILE_CONNECT_CONNECTED_HUB')}</CardTitle>
            </div>
            <CardDescription className="break-all">{getHubBaseUrlSync() ?? t('MOBILE_CONNECT_NO_HUB_SELECTED')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" data-testid="switch-hub-btn" onClick={() => setSwitchHubOpen(true)}>
              {t('MOBILE_CONNECT_SWITCH_HUB')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={switchHubOpen} onOpenChange={setSwitchHubOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('MOBILE_CONNECT_SWITCH_HUB_CONFIRM_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="py-2">{t('MOBILE_CONNECT_SWITCH_HUB_CONFIRM_DESC')}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSwitchHubOpen(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              data-testid="switch-hub-confirm-btn"
              onClick={async () => {
                await clearHubConnection();
                window.location.href = '/connect';
              }}
            >
              {t('MOBILE_CONNECT_SWITCH_HUB')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
