import {
  checkForUpdates as checkHubForUpdates,
  factoryReset,
  getAutoUpdates,
  restartOnboarding,
  setAutoUpdates as updateAutoUpdatesSetting,
} from '@/api-client/sdk.gen';
import { sdkResult, unwrapSdkOrNull } from '@/lib/sdk-unwrap';
import { Markdown } from '@/components/markdown/markdown';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { ArrowUpCircle, Loader2, Smartphone, Star, TriangleAlert, Wand2 } from 'lucide-react';
import { clearHubConnection, getHubBaseUrlSync, isTauriMobileSync, usesCloudConnect } from '@/lib/mobile-connection';
import { Trans, useTranslation } from 'react-i18next';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';
import { useState, useEffect, useCallback, useId } from 'react';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import {
  clearHubSteadySession,
  clearStackUpdatePending,
  isStackUpdatePending,
  markStackUpdatePending,
  subscribeStackUpdate,
} from '@/lib/desktop-stack-session';
import { toast } from 'sonner';
import {
  checkForUpdates,
  type DesktopRestartState,
  type DesktopUpdateOutcome,
  type DesktopUpdateProgress,
  fetchHostListenerStatus,
  getDesktopRestartState,
  getInstalledDesktopVersion,
  installDesktopUpdate,
  isStackUpdateAvailable,
  isTauri,
  manualUpdateArtifactKind,
  manualUpdateFileName,
  performStackUpdate,
  performUpdate,
  restartDesktopApp,
  type UpdateActionResult,
  type UpdateInfo,
} from '@/lib/update-service';

/** The one-click desktop app update, in the desktop window. */
type ShellInstallState =
  | { state: 'idle' }
  | {
      state: 'installing';
      progress: DesktopUpdateProgress | null;
      /** Set once the call failed and the page is starting the Hub again: after the install, or instead of it. */
      restartingHub: 'after-install' | 'after-failure' | null;
    }
  | DesktopUpdateOutcome;

/** What each step the desktop app reports reads as. A step not listed reads as the update starting. */
const SHELL_INSTALL_PHASE_KEYS: Record<string, string> = {
  prepare: 'SETTINGS_ACTIONS_SHELL_INSTALL_PREPARING',
  stop: 'SETTINGS_ACTIONS_SHELL_INSTALL_STOPPING_HUB',
  download: 'SETTINGS_ACTIONS_SHELL_INSTALL_DOWNLOADING',
  verify: 'SETTINGS_ACTIONS_SHELL_INSTALL_VERIFYING',
  install: 'SETTINGS_ACTIONS_SHELL_INSTALL_INSTALLING',
  done: 'SETTINGS_ACTIONS_SHELL_INSTALL_RESTARTING_APP',
  relaunch: 'SETTINGS_ACTIONS_SHELL_INSTALL_RESTARTING_APP',
};

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version, refreshAppContext, userSettings } = useAppContext();
  const deviceName = userSettings?.ciHubDeviceSlug?.trim() ?? '';
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
  const autoUpdatesId = useId();
  const autoUpdatesTitleId = `${autoUpdatesId}-title`;
  const autoUpdatesDescriptionId = `${autoUpdatesId}-description`;
  const [restartingWizard, setRestartingWizard] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [factoryResetPhrase, setFactoryResetPhrase] = useState('');
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [shellUpdate, setShellUpdate] = useState<UpdateInfo | null>(null);
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  const [updatingShell, setUpdatingShell] = useState(false);
  const [shellRestart, setShellRestart] = useState<DesktopRestartState | null>(null);
  const [restartingShell, setRestartingShell] = useState(false);
  const [shellInstall, setShellInstall] = useState<ShellInstallState>({ state: 'idle' });
  const [hostListenerReachable, setHostListenerReachable] = useState<boolean | null>(null);
  const [switchHubOpen, setSwitchHubOpen] = useState(false);

  const desktop = isTauri();
  // The desktop app's own window, where this page can ask the app to install its update. `isTauri()`
  // is true in the phone app too, which only reaches a Hub over the network, like a browser.
  const desktopWindow = desktop && !isTauriMobileSync();

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

  const setFactoryResetDialogOpen = useCallback((open: boolean) => {
    setFactoryResetOpen(open);
    // Cancel, the X, and a click outside all close through here. A phrase left in state would
    // still match the device name, so the next open could wipe the Hub in one click.
    if (!open) setFactoryResetPhrase('');
  }, []);

  const handleFactoryReset = useCallback(async () => {
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }
    const typedName = factoryResetPhrase.trim();
    if (!deviceName || typedName !== deviceName) {
      toast.error(t('SETTINGS_FACTORY_RESET_CONFIRMATION_MISMATCH'));
      return;
    }

    setFactoryResetting(true);
    try {
      const result = await factoryReset({ body: { confirmation: typedName } });
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
  }, [demoMode, deviceName, factoryResetPhrase, t]);

  const refreshShellUpdateState = useCallback(async () => {
    const installedVersion = desktop ? await getInstalledDesktopVersion() : null;
    setShellVersion(installedVersion);
    setShellRestart(desktop ? await getDesktopRestartState() : null);
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

  const handleShellRestart = useCallback(async () => {
    setRestartingShell(true);
    // On success the app exits; it only comes back here when the restart was refused.
    if (!(await restartDesktopApp())) {
      setRestartingShell(false);
      toast.error(t('DESKTOP_RESTART_FAILED'));
    }
  }, [t]);

  const handleShellInstall = useCallback(async () => {
    if (!shellUpdate?.downloadUrl) return;
    setShellMessage(null);
    setShellInstall({ state: 'installing', progress: null, restartingHub: null });
    // On success the app exits into the new version, so this usually never returns.
    const outcome = await installDesktopUpdate(shellUpdate, {
      onProgress: (progress) => setShellInstall((current) => (current.state === 'installing' ? { ...current, progress } : current)),
      onRestartingHub: (installed) =>
        setShellInstall((current) =>
          current.state === 'installing' ? { ...current, restartingHub: installed ? 'after-install' : 'after-failure' } : current,
        ),
    });
    setShellInstall(outcome);
  }, [shellUpdate]);

  const handleAutoUpdatesToggle = useCallback(async () => {
    // Stay focusable while the save runs. `disabled` would drop keyboard focus to the page.
    if (autoUpdatesLoading) return;
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
  }, [autoUpdates, autoUpdatesLoading]);

  const stackUpdateAvailable = isStackUpdateAvailable(version.current, version.latest);
  // After an update installed while the app was open, the running version is no longer what this
  // computer has installed.
  const installedShellVersion = (shellRestart?.restartRequired && shellRestart.installedVersion) || shellVersion;
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
    // Commands name the downloaded file exactly, quoted for the space in "Companion Hub_…": a glob
    // like `./companion-hub_*.deb` matched no download, so apt refused it. A name that isn't safe to
    // quote gets the same step without a command.
    const fileName = manualUpdateFileName(shellUpdate.downloadUrl);
    let steps: { text: string; command?: string }[] | null = null;

    if (kind === 'appimage') {
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        fileName
          ? { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_APPIMAGE_STEP_REPLACE'), command: `chmod +x "./${fileName}"` }
          : { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_APPIMAGE_STEP_REPLACE_NO_COMMAND') },
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_RELAUNCH') },
      ];
    } else if (kind === 'deb' || kind === 'rpm') {
      // Install over the current app, never remove it first. Removing the package runs its cleanup,
      // which deletes the Hub's database, every app with its data, and the Hub's folder. An install
      // in place skips that: the old package's deb `postrm` sees `upgrade`, its rpm `postun` sees 1.
      const install = kind === 'deb' ? 'sudo apt install' : 'sudo rpm -U';
      steps = [
        { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_DOWNLOAD') },
        fileName
          ? { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_INSTALL'), command: `${install} "./${fileName}"` }
          : { text: t('SETTINGS_ACTIONS_MANUAL_UPDATE_STEP_INSTALL_NO_COMMAND') },
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

  /**
   * The desktop window installs the update itself. When that fails, the card offers the installer
   * download and the steps to install it by hand, as it does in a browser.
   */
  const renderShellInstall = (update: UpdateInfo) => {
    const installing = shellInstall.state === 'installing';
    const kind = manualUpdateArtifactKind(update.downloadUrl);
    // A .deb or .rpm installs through pkexec, which asks for the password; an AppImage is copied in place.
    const asksForPassword = kind === 'deb' || kind === 'rpm';
    let progressKey = 'SETTINGS_ACTIONS_SHELL_INSTALL_STARTING';
    if (shellInstall.state === 'installing') {
      if (shellInstall.restartingHub === 'after-install') {
        progressKey = 'SETTINGS_ACTIONS_SHELL_INSTALL_RESTART_FAILED_RESTARTING_HUB';
      } else if (shellInstall.restartingHub === 'after-failure') {
        progressKey = 'SETTINGS_ACTIONS_SHELL_INSTALL_RESTARTING_HUB';
      } else {
        progressKey = SHELL_INSTALL_PHASE_KEYS[shellInstall.progress?.phase ?? ''] ?? progressKey;
      }
    }
    // What the page did about the Hub, which the updater may have stopped, once the call failed.
    const renderHubAfterUpdate = (outcome: { hub: 'running' | 'restarted' | 'restart-failed'; hubError?: string }) => (
      <>
        {outcome.hub === 'restarted' ? <p className="text-muted-foreground">{t('SETTINGS_ACTIONS_SHELL_INSTALL_HUB_RESTARTED')}</p> : null}
        {outcome.hub === 'restart-failed' ? (
          <p className="text-muted-foreground">{t('SETTINGS_ACTIONS_SHELL_INSTALL_HUB_RESTART_FAILED', { error: outcome.hubError ?? '' })}</p>
        ) : null}
      </>
    );

    return (
      <>
        <Button onClick={handleShellInstall} disabled={installing || shellInstall.state === 'installed'} data-testid="hub-shell-install-btn">
          {installing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              {t('SETTINGS_ACTIONS_SHELL_INSTALLING')}
            </>
          ) : (
            t('SETTINGS_ACTIONS_SHELL_INSTALL_VERSION', { version: update.latestVersion })
          )}
        </Button>
        {shellInstall.state === 'installing' ? (
          <div className="mt-3 space-y-1 text-sm" role="status" data-testid="desktop-update-progress">
            <p>{t(progressKey, { version: update.latestVersion })}</p>
            {asksForPassword && !shellInstall.restartingHub ? (
              <p className="text-muted-foreground">{t('SETTINGS_ACTIONS_SHELL_INSTALL_PASSWORD_HINT')}</p>
            ) : null}
            {/* Said up front: the app exits within moments of installing, so a later step rarely shows.
                Apps up to 0.2.77 on Linux exit without opening the new version. */}
            {shellInstall.restartingHub ? null : <p className="text-muted-foreground">{t('SETTINGS_ACTIONS_SHELL_INSTALL_RESTART_HINT')}</p>}
          </div>
        ) : null}
        {shellInstall.state === 'installed' && shellInstall.restart === 'restarting' ? (
          <p className="mt-3 text-sm" role="status" data-testid="desktop-update-progress">
            {t('SETTINGS_ACTIONS_SHELL_INSTALL_RESTARTING_APP', { version: update.latestVersion })}
          </p>
        ) : null}
        {/* Installed, so nothing to download or install by hand: only the restart is left. */}
        {shellInstall.state === 'installed' && shellInstall.restart === 'failed' ? (
          <div className="mt-3 space-y-1 text-sm" role="status" data-testid="desktop-update-restart-failed">
            <p>{t('SETTINGS_ACTIONS_SHELL_INSTALL_RESTART_FAILED', { version: update.latestVersion })}</p>
            {renderHubAfterUpdate(shellInstall)}
          </div>
        ) : null}
        {shellInstall.state === 'failed' && shellInstall.reason === 'busy' ? (
          <p className="mt-3 text-sm" role="status" data-testid="desktop-update-busy">
            {t('SETTINGS_ACTIONS_SHELL_INSTALL_BUSY')}
          </p>
        ) : null}
        {shellInstall.state === 'failed' && shellInstall.reason !== 'busy' ? (
          <div className="mt-3" data-testid="desktop-update-failed">
            <div className="mb-3 space-y-1 text-sm">
              <p className="text-destructive">
                {shellInstall.reason === 'unsupported'
                  ? t('SETTINGS_ACTIONS_SHELL_INSTALL_UNSUPPORTED')
                  : t('SETTINGS_ACTIONS_SHELL_INSTALL_FAILED', { error: shellInstall.error })}
              </p>
              {renderHubAfterUpdate(shellInstall)}
            </div>
            <Button variant="outline" onClick={handleShellUpdate} disabled={updatingShell} data-testid="hub-shell-update-btn">
              {updatingShell ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t('SETTINGS_ACTIONS_CHECKING')}
                </>
              ) : (
                t('SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_VERSION', { version: update.latestVersion })
              )}
            </Button>
            {shellMessage ? <p className="mt-3 text-sm text-muted-foreground">{shellMessage}</p> : null}
            {renderManualUpdateInstructions()}
          </div>
        ) : null}
      </>
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
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 id={autoUpdatesTitleId} className="text-sm font-medium">
                  {t('SETTINGS_ACTIONS_AUTO_UPDATE_STACK_TITLE')}
                </h3>
                <p id={autoUpdatesDescriptionId} className="text-sm text-muted-foreground">
                  {t('SETTINGS_ACTIONS_AUTO_UPDATE_STACK_DESCRIPTION')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoUpdates}
                aria-labelledby={autoUpdatesTitleId}
                aria-describedby={autoUpdatesDescriptionId}
                aria-disabled={autoUpdatesLoading}
                aria-busy={autoUpdatesLoading}
                onClick={handleAutoUpdatesToggle}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${autoUpdates ? 'bg-primary' : 'bg-foreground/50'} ${autoUpdatesLoading ? 'cursor-wait opacity-50' : ''}`}
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
            {installedShellVersion
              ? t('SETTINGS_ACTIONS_SHELL_UPDATE_SUBTITLE_WITH_VERSION', { version: installedShellVersion })
              : t('SETTINGS_ACTIONS_SHELL_UPDATE_SUBTITLE')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* The Hub can't reach the listener of any desktop app up to 0.2.77, running or not, so in the
              desktop window it is no sign the app is down. A browser can say where to update instead. */}
          {!desktopWindow && hostListenerReachable === false ? (
            <p className="text-sm text-muted-foreground mb-4" data-testid="host-listener-unavailable">
              <Trans
                i18nKey="SETTINGS_ACTIONS_HOST_LISTENER_UNAVAILABLE"
                components={{ code: <code className="rounded bg-muted px-1 font-mono text-xs" /> }}
              />
            </p>
          ) : null}
          {hostListenerReachable === true ? (
            <p className="text-sm text-muted-foreground mb-4" data-testid="host-listener-ready">
              {t('SETTINGS_ACTIONS_HOST_LISTENER_READY')}
            </p>
          ) : null}
          {shellRestart?.restartRequired ? (
            <div data-testid="desktop-restart-required">
              <p className="text-sm mb-2">
                {shellRestart.installedVersion
                  ? t('SETTINGS_ACTIONS_SHELL_RESTART_REQUIRED', { installed: shellRestart.installedVersion, running: shellRestart.runningVersion })
                  : t('SETTINGS_ACTIONS_SHELL_RESTART_REQUIRED_UNKNOWN_VERSION', { running: shellRestart.runningVersion })}
              </p>
              <p className="text-sm text-muted-foreground mb-3">{t('SETTINGS_ACTIONS_SHELL_RESTART_HUB_NOTE')}</p>
              <Button onClick={handleShellRestart} disabled={restartingShell} data-testid="desktop-restart-btn">
                {restartingShell ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t('SETTINGS_ACTIONS_SHELL_RESTARTING')}
                  </>
                ) : (
                  t('SETTINGS_ACTIONS_SHELL_RESTART_BUTTON')
                )}
              </Button>
            </div>
          ) : shellUpdate?.downloadUrl && desktopWindow && shellUpdate.updateAvailable ? (
            renderShellInstall(shellUpdate)
          ) : shellUpdate?.downloadUrl ? (
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
          <Button
            intent="danger"
            variant="outline"
            disabled={demoMode}
            onClick={() => setFactoryResetDialogOpen(true)}
            data-testid="factory-reset-btn"
          >
            {t('SETTINGS_FACTORY_RESET_BUTTON')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={factoryResetOpen} onOpenChange={setFactoryResetDialogOpen}>
        <DialogContent type="danger" size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_FACTORY_RESET_DIALOG_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="space-y-4 py-2">
            <p>{t('SETTINGS_FACTORY_RESET_DIALOG_BODY')}</p>
            <div className="space-y-3 text-left">
              {deviceName ? (
                <>
                  <label htmlFor="factory-reset-confirmation" className="block text-sm font-medium">
                    {t('SETTINGS_FACTORY_RESET_CONFIRMATION_LABEL', { phrase: deviceName })}
                  </label>
                  <Input
                    id="factory-reset-confirmation"
                    value={factoryResetPhrase}
                    onChange={(event) => setFactoryResetPhrase(event.target.value)}
                    autoComplete="off"
                    data-testid="factory-reset-confirmation-input"
                  />
                </>
              ) : (
                <p data-testid="factory-reset-no-device-name">{t('SETTINGS_FACTORY_RESET_NO_DEVICE_NAME')}</p>
              )}
            </div>
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFactoryResetDialogOpen(false)} disabled={factoryResetting}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              intent="danger"
              loading={factoryResetting}
              disabled={!deviceName || factoryResetPhrase.trim() !== deviceName}
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
