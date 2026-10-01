import semver from 'semver';
import { type DesktopReleaseManifest, desktopInstallerUrl, desktopReleaseCdn, isTrustedDownloadUrlForHost } from '@ci-hub/common/types';
import { openExternal } from '@/lib/helpers/open-external';
import { isMobileUserAgent, isTauriMobileSync } from '@/lib/mobile-connection';

function updateCdnConfig() {
  return desktopReleaseCdn(import.meta.env.CI_HUB_ENVIRONMENT);
}

const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DISMISSED_KEY = 'ci-hub-update-dismissed-version';
const TOAST_SHOWN_KEY = 'ci-hub-update-toast-shown';

export function isTrustedDownloadUrl(url: string): boolean {
  return isTrustedDownloadUrlForHost(url, updateCdnConfig().host);
}

interface LatestJson {
  version: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  updateAvailable: boolean;
  platform: DesktopPlatform | null;
  manualDownload: boolean;
}

interface NativeDesktopUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  updateAvailable: boolean;
}

export type DesktopPlatform = 'linux' | 'macos' | 'windows';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function getCurrentVersion(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const version = await invoke<string>('get_desktop_release_version_command');
      return version.trim().replace(/^v/, '');
    } catch {
      return null;
    }
  }
  return null;
}

export async function getInstalledDesktopVersion(): Promise<string | null> {
  return getCurrentVersion();
}

/** Whether an update installed another desktop app version while this one was open. */
export interface DesktopRestartState {
  runningVersion: string;
  /** The version on disk, when the new program said which. */
  installedVersion: string | null;
  restartRequired: boolean;
}

/** `null` outside the desktop app, and from desktop apps too old to tell. */
export async function getDesktopRestartState(): Promise<DesktopRestartState | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const state = await invoke<DesktopRestartState>('get_desktop_restart_state_command');
    return {
      runningVersion: state.runningVersion,
      installedVersion: state.installedVersion ?? null,
      restartRequired: Boolean(state.restartRequired),
    };
  } catch {
    return null;
  }
}

/**
 * Restarts the desktop app onto the version an update installed. The app exits while this is in
 * flight, so a resolved call only means the app took the request; `false` means it refused or
 * could not restart.
 */
export async function restartDesktopApp(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restart_desktop_app_command');
    return true;
  } catch {
    return false;
  }
}

export function detectBrowserPlatform(): DesktopPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

export function detectBrowserArch(): string {
  if (typeof navigator === 'undefined') return 'x86_64';
  const ua = navigator.userAgent.toLowerCase();
  const uad = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
  if (uad?.architecture === 'arm' || /arm64|aarch64/.test(ua)) return 'aarch64';
  // Safari on Apple Silicon still reports MacIntel; prefer arm for macOS downloads.
  if (detectBrowserPlatform() === 'macos') return 'aarch64';
  return 'x86_64';
}

export async function getDesktopPlatform(): Promise<DesktopPlatform | null> {
  if (isTauri()) {
    try {
      const { platform } = await import('@tauri-apps/plugin-os');
      const value = await platform();
      if (value === 'linux' || value === 'macos' || value === 'windows') {
        return value;
      }
    } catch {
      // Fall through to user-agent detection.
    }
  }

  if (typeof navigator === 'undefined') return null;
  return detectBrowserPlatform();
}

/**
 * The CPU a Chromium browser reports through client hints, or null. Its user agent says "Intel Mac" on
 * Apple silicon too, so this is how a page tells the two Macs apart. Safari and Firefox don't report it.
 */
async function browserArchFromClientHints(): Promise<string | null> {
  if (typeof navigator === 'undefined') return null;
  const uad = (navigator as unknown as { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } })
    .userAgentData;
  try {
    const hints = await uad?.getHighEntropyValues?.(['architecture']);
    if (hints?.architecture === 'arm') return 'aarch64';
    if (hints?.architecture === 'x86') return 'x86_64';
  } catch {
    // The browser refused the hint: the user agent decides.
  }
  return null;
}

export async function getDesktopArch(): Promise<string> {
  if (isTauri()) {
    try {
      const { arch } = await import('@tauri-apps/plugin-os');
      const value = await arch();
      if (value === 'aarch64' || value === 'arm') return 'aarch64';
      if (value) return 'x86_64';
    } catch {
      // Fall through to user-agent detection.
    }
  }

  return (await browserArchFromClientHints()) ?? detectBrowserArch();
}

/**
 * A page outside the desktop app downloads an installer on every platform. Only the desktop window
 * installs one itself, through {@link installDesktopUpdate}.
 */
export function requiresManualDesktopUpdate(_platform?: DesktopPlatform | null): boolean {
  return true;
}

export type ManualUpdateArtifactKind = 'deb' | 'rpm' | 'appimage' | 'dmg' | 'exe' | 'msi';

/** Installer format of a manual-download update, for tailored on-screen instructions. */
export function manualUpdateArtifactKind(downloadUrl: string): ManualUpdateArtifactKind | null {
  const path = (downloadUrl.split(/[?#]/)[0] ?? '').toLowerCase();
  if (path.endsWith('.deb')) return 'deb';
  if (path.endsWith('.rpm')) return 'rpm';
  if (path.endsWith('.appimage')) return 'appimage';
  if (path.endsWith('.dmg')) return 'dmg';
  if (path.endsWith('.msi')) return 'msi';
  if (path.endsWith('.exe')) return 'exe';
  return null;
}

async function resolveInstallerFromCdn(
  platform: DesktopPlatform | null,
  osArch: string,
): Promise<{ latestVersion: string; downloadUrl: string } | null> {
  const { base } = updateCdnConfig();
  const latestRes = await fetch(`${base}/latest.json`, { cache: 'no-store' });
  if (!latestRes.ok) return null;

  const latest = (await latestRes.json()) as LatestJson;
  const latestVersion = latest.version.replace(/^v/, '');
  if (!semver.valid(latestVersion)) return null;

  const manifestRes = await fetch(`${base}/v${latestVersion}/manifest.json`, { cache: 'no-store' });
  if (!manifestRes.ok) return null;

  const manifest = (await manifestRes.json()) as DesktopReleaseManifest;
  let downloadUrl = platform ? (desktopInstallerUrl(manifest, platform, osArch) ?? '') : '';
  if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
    downloadUrl = '';
  }

  return { latestVersion, downloadUrl };
}

/**
 * A browser cannot read the download servers itself: they send no CORS headers. The Hub reads the
 * server this page was built for, and the URL it returns still has to pass this page's trust check.
 */
async function resolveInstallerFromHub(
  platform: DesktopPlatform | null,
  osArch: string,
): Promise<{ latestVersion: string; downloadUrl: string } | null> {
  // A phone or tablet cannot install the desktop app, and its user agent passes for macOS (iOS)
  // or Linux (Android), so it gets no installer and the Hub is not asked.
  if (isMobileUserAgent()) return null;

  const { getDesktopRelease } = await import('@/api-client/sdk.gen');
  const { unwrapSdkOrNull } = await import('@/lib/sdk-unwrap');
  // The Hub sends null for what it could not find; the generated type loses that because the spec
  // marks it with OpenAPI 3.0's `nullable`.
  const release: { latestVersion: string | null; downloadUrl: string | null } | null = await unwrapSdkOrNull(
    getDesktopRelease({
      query: {
        environment: import.meta.env.CI_HUB_ENVIRONMENT,
        platform: platform ?? undefined,
        arch: osArch === 'aarch64' ? 'aarch64' : 'x86_64',
      },
    }),
  );
  const latestVersion = release?.latestVersion?.replace(/^v/, '') ?? '';
  if (!semver.valid(latestVersion)) return null;

  const downloadUrl = release?.downloadUrl ?? '';
  return { latestVersion, downloadUrl: isTrustedDownloadUrl(downloadUrl) ? downloadUrl : '' };
}

export async function checkForUpdates(fallbackCurrentVersion?: string): Promise<UpdateInfo | null> {
  const currentVersion = (fallbackCurrentVersion ?? (await getCurrentVersion()) ?? '').replace(/^v/, '');
  const desktopPlatform = await getDesktopPlatform();
  const osArch = await getDesktopArch();

  try {
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Desktop update metadata is fetched natively because the production CDN does not
        // expose CORS headers for renderer-side fetches from the Tauri webview.
        const nativeInfo = await invoke<NativeDesktopUpdateInfo>('check_desktop_update_command');
        const nativeCurrentVersion = nativeInfo.currentVersion.replace(/^v/, '');
        const latestVersion = nativeInfo.latestVersion.replace(/^v/, '');
        if (!semver.valid(latestVersion)) {
          return null;
        }

        let downloadUrl = nativeInfo.downloadUrl ?? '';
        if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
          downloadUrl = '';
        }
        if (!downloadUrl) {
          try {
            const resolved = await resolveInstallerFromCdn(desktopPlatform, osArch);
            if (resolved?.downloadUrl) {
              downloadUrl = resolved.downloadUrl;
            }
          } catch {
            // CDN is best-effort when the native check omitted a URL.
          }
        }

        const resolvedCurrent = semver.valid(nativeCurrentVersion) ? nativeCurrentVersion : currentVersion;
        return {
          currentVersion: resolvedCurrent || latestVersion,
          latestVersion,
          downloadUrl,
          updateAvailable: Boolean(resolvedCurrent && semver.valid(resolvedCurrent) && semver.gt(latestVersion, resolvedCurrent)),
          platform: desktopPlatform,
          manualDownload: true,
        };
      } catch {
        // Fall back to the fetch path for tests and nonstandard dev environments.
      }
    }

    // Only a plain browser asks the Hub. The desktop and phone apps land here when their native check
    // fails and keep their direct read, so the phone app does not start offering desktop installers.
    const resolved = isTauri() ? await resolveInstallerFromCdn(desktopPlatform, osArch) : await resolveInstallerFromHub(desktopPlatform, osArch);
    if (!resolved) return null;

    const updateAvailable = Boolean(currentVersion && semver.valid(currentVersion) && semver.gt(resolved.latestVersion, currentVersion));
    return {
      currentVersion: currentVersion || resolved.latestVersion,
      latestVersion: resolved.latestVersion,
      downloadUrl: resolved.downloadUrl,
      updateAvailable,
      platform: desktopPlatform,
      manualDownload: true,
    };
  } catch {
    return null;
  }
}

export function isStackUpdateAvailable(current: string, latest: string): boolean {
  if (!semver.valid(current) || !semver.valid(latest)) return false;
  return semver.gt(latest, current);
}

/** Whether Settings should show an Update button (desktop manifest vs stack registry). */
export function isHubUpdateAvailable(desktop: boolean, desktopUpdate: UpdateInfo | null, currentVersion: string, latestVersion: string): boolean {
  if (desktop) {
    return !!desktopUpdate?.updateAvailable;
  }
  return isStackUpdateAvailable(currentVersion, latestVersion);
}

export function dismissVersion(version: string): void {
  localStorage.setItem(DISMISSED_KEY, version);
}

export function isVersionDismissed(version: string): boolean {
  return localStorage.getItem(DISMISSED_KEY) === version;
}

export function markToastShown(version: string): void {
  localStorage.setItem(TOAST_SHOWN_KEY, version);
}

export function wasToastShown(version: string): boolean {
  return localStorage.getItem(TOAST_SHOWN_KEY) === version;
}

export function getPollIntervalMs(): number {
  return POLL_INTERVAL_MS;
}

export interface UpdateActionResult {
  ok: boolean;
  messageKey: string;
  messageParams?: Record<string, string>;
  defaultMessage?: string;
  stack?: 'updating' | 'skipped' | 'failed';
  host?: 'started' | 'unavailable' | 'failed';
}

export async function fetchHostListenerStatus(): Promise<boolean | null> {
  try {
    const { getHostListenerStatus } = await import('@/api-client/sdk.gen');
    const { sdkResult } = await import('@/lib/sdk-unwrap');
    const result = await sdkResult(getHostListenerStatus());
    if (!result.ok) return null;
    return Boolean((result.data as { reachable?: boolean } | null)?.reachable);
  } catch {
    return null;
  }
}

export async function performUpdate(info: UpdateInfo): Promise<UpdateActionResult> {
  if (!info.downloadUrl || !isTrustedDownloadUrl(info.downloadUrl)) {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL' };
  }

  try {
    await openExternal(info.downloadUrl);
    return {
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    };
  } catch {
    return {
      ok: false,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_FAILED',
      defaultMessage: 'Could not open the installer download.',
    };
  }
}

/** A step the desktop app reports while it installs an update (`get_update_progress_command`). */
export interface DesktopUpdateProgress {
  /** `prepare`, `stop`, `download`, `verify`, `install`, `done` or `relaunch`; `error` from an update the Hub started. */
  phase: string;
  message: string;
}

/** What this page did about the Hub after the call failed; see {@link installDesktopUpdate}. */
interface HubAfterDesktopUpdate {
  hub: 'running' | 'restarted' | 'restart-failed';
  hubError?: string;
}

/**
 * How a one-click desktop update ended, when it ends here at all: a successful install exits the
 * desktop app and starts the new version, so the call usually never returns.
 *
 * - `installed`, `restart: 'restarting'`: the call returned, so the app is starting the new version.
 * - `installed`, `restart: 'failed'`: the update is installed, but the app couldn't start the new
 *   version, so this window still runs the old one. `error` is the app's own words.
 * - `failed`: nothing was installed. `reason` is `unsupported` when the app won't run the install for
 *   this page (too old to have the command, or not allowed to), `busy` when it is already installing
 *   an update, which restarts it when done, and `error` when the install itself failed.
 */
export type DesktopUpdateOutcome =
  | { state: 'installed'; restart: 'restarting' }
  | ({ state: 'installed'; restart: 'failed'; error: string } & HubAfterDesktopUpdate)
  | ({ state: 'failed'; reason: 'unsupported' | 'busy' | 'error'; error: string } & HubAfterDesktopUpdate);

export interface DesktopUpdateCallbacks {
  /** Each new step the desktop app reports. */
  onProgress?: (progress: DesktopUpdateProgress) => void;
  /**
   * The call failed with the Hub down, and this page is starting the Hub again. `installed` says
   * whether the update was installed first and only the app's restart failed.
   */
  onRestartingHub?: (installed: boolean) => void;
}

const DESKTOP_UPDATE_PROGRESS_POLL_MS = 1000;

/**
 * Steps the app reports only after the install succeeded: `done`, then `relaunch` while it starts
 * the new version.
 */
const DESKTOP_UPDATE_INSTALLED_PHASES = new Set(['done', 'relaunch']);

/** Installs this page is waiting on. A second click while one runs is refused by the app, quickly. */
let desktopUpdatesRunning = 0;

/**
 * True while this page waits on the desktop app to install an update. The desktop gate keeps the page
 * on screen meanwhile: the updater stops the Hub (older apps before they install, current ones once
 * the update is installed), and the gate would otherwise swap the page for its "isn't running"
 * screen, along with the update's progress.
 */
export function isDesktopUpdateRunning(): boolean {
  return desktopUpdatesRunning > 0;
}

function invokeErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

type CoreInvoke = typeof import('@tauri-apps/api/core').invoke;

async function readDesktopUpdateProgress(invoke: CoreInvoke): Promise<DesktopUpdateProgress | null> {
  try {
    const progress = await invoke<DesktopUpdateProgress | null>('get_update_progress_command');
    return progress && typeof progress.phase === 'string' ? { phase: progress.phase, message: progress.message ?? '' } : null;
  } catch {
    return null;
  }
}

function sameProgress(a: DesktopUpdateProgress | null, b: DesktopUpdateProgress | null): boolean {
  return a?.phase === b?.phase && a?.message === b?.message;
}

/** Starts the Hub when its API no longer answers, as after an update that failed once the stack was stopped. */
async function startHubIfDown(invoke: CoreInvoke, onRestartingHub: () => void): Promise<HubAfterDesktopUpdate> {
  const { probeHealthyHubApiPort } = await import('@/lib/tauri-hub-probe');
  if ((await probeHealthyHubApiPort()) !== null) return { hub: 'running' };
  onRestartingHub();
  try {
    await invoke('start_hub_command');
    return { hub: 'restarted' };
  } catch (error) {
    return { hub: 'restart-failed', hubError: invokeErrorText(error) };
  }
}

/**
 * Installs a desktop app update from the desktop window in one click. The desktop app downloads the
 * installer, checks it against the release manifest (size and SHA-256), installs it (`pkexec` on
 * Linux, which asks for the password), and exits into the new version.
 *
 * Older desktop apps stop the Hub before they download, and leave it stopped when the install fails,
 * for example when the password prompt is cancelled. Current ones keep it running until the update is
 * installed. So after a failure, a Hub whose API no longer answers is started again. The outcome says
 * what happened; the caller offers the download.
 */
export async function installDesktopUpdate(info: UpdateInfo, callbacks: DesktopUpdateCallbacks = {}): Promise<DesktopUpdateOutcome> {
  if (!isTauri() || !info.downloadUrl || !isTrustedDownloadUrl(info.downloadUrl)) {
    return { state: 'failed', reason: 'unsupported', error: 'No trusted download URL for this desktop app', hub: 'running' };
  }

  desktopUpdatesRunning += 1;
  let polling: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (polling !== null) clearInterval(polling);
    polling = null;
  };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // The app keeps the last update's progress, a failed one's too, until the next update reports a
    // step. Skip that leftover until the progress moves.
    let reported = await readDesktopUpdateProgress(invoke);
    let moved = false;
    polling = setInterval(() => {
      void readDesktopUpdateProgress(invoke).then((progress) => {
        if (polling === null || !progress || sameProgress(progress, reported)) return;
        reported = progress;
        moved = true;
        callbacks.onProgress?.(progress);
      });
    }, DESKTOP_UPDATE_PROGRESS_POLL_MS);

    try {
      await invoke('perform_desktop_update_command', { downloadUrl: info.downloadUrl });
      // Releases so far exit inside the call; one that returns has installed and restarts itself.
      return { state: 'installed', restart: 'restarting' };
    } catch (error) {
      stopPolling();
      const text = invokeErrorText(error);
      if (/not allowed by ACL|command \S+ not found/i.test(text)) {
        return { state: 'failed', reason: 'unsupported', error: text, hub: 'running' };
      }
      // Another install holds the app's update lock and restarts the app when it's done: leave the
      // Hub to it.
      if (/already in progress/i.test(text)) {
        return { state: 'failed', reason: 'busy', error: text, hub: 'running' };
      }
      // The app also fails after a good install when it can't start the new version. The step it
      // reached tells the two apart, whatever the error says; polls come a second apart, so read the
      // step once more.
      const last = await readDesktopUpdateProgress(invoke);
      if (last && !sameProgress(last, reported)) {
        reported = last;
        moved = true;
      }
      const installed = moved && reported !== null && DESKTOP_UPDATE_INSTALLED_PHASES.has(reported.phase);
      const hub = await startHubIfDown(invoke, () => callbacks.onRestartingHub?.(installed));
      return installed ? { state: 'installed', restart: 'failed', error: text, ...hub } : { state: 'failed', reason: 'error', error: text, ...hub };
    }
  } catch (error) {
    return { state: 'failed', reason: 'unsupported', error: invokeErrorText(error), hub: 'running' };
  } finally {
    stopPolling();
    desktopUpdatesRunning -= 1;
  }
}

/** Hub-driven update: stack pull, and host listener when the desktop app is running. */
export async function performStackUpdate(targetVersion?: string): Promise<UpdateActionResult> {
  try {
    const { performUpdate } = await import('@/api-client/sdk.gen');
    const { sdkResult } = await import('@/lib/sdk-unwrap');
    const result = await sdkResult(performUpdate({ body: { targetVersion } } as Parameters<typeof performUpdate>[0]));
    if (result.ok) {
      const data = (result.data ?? {}) as { stack?: UpdateActionResult['stack']; host?: UpdateActionResult['host'] };
      const host = data.host;
      const stack = data.stack;
      let messageKey = 'SETTINGS_ACTIONS_UPDATE_RESTARTING';
      if (host === 'started') {
        messageKey = 'SETTINGS_ACTIONS_UPDATE_HOST_STARTED';
      } else if (host === 'unavailable' || host === 'failed') {
        // The Hub could not hand the update to the desktop app, which is no sign that the app isn't
        // running: desktop apps up to 0.2.77 keep their listener token where the Hub can't read it.
        // In the desktop window, the Desktop app card updates the app itself.
        messageKey =
          isTauri() && !isTauriMobileSync() ? 'SETTINGS_ACTIONS_UPDATE_STACK_DESKTOP_SEPARATE' : 'SETTINGS_ACTIONS_UPDATE_STACK_HOST_UNAVAILABLE';
      }
      return { ok: true, messageKey, stack, host };
    }
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_FAILED' };
  } catch {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED' };
  }
}
