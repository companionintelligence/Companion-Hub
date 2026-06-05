import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GuiEnvironmentResolution {
  env: Record<string, string>;
  source: string;
}

export interface TauriPrereqIssue {
  code: 'missing-display' | 'missing-library' | 'unsupported-platform';
  message: string;
  hint?: string;
}

export interface TauriPrereqResult {
  ok: boolean;
  issues: TauriPrereqIssue[];
  guiEnv: GuiEnvironmentResolution | null;
}

const LINUX_LIBS: Array<{ label: string; sonames: string[]; aptPackage: string }> = [
  {
    label: 'GTK 3',
    sonames: ['libgtk-3.so.0'],
    aptPackage: 'libgtk-3-0',
  },
  {
    label: 'WebKitGTK 4.1',
    sonames: ['libwebkit2gtk-4.1.so.0'],
    aptPackage: 'libwebkit2gtk-4.1-0',
  },
];

const LINUX_LIB_SEARCH_DIRS = [
  '/usr/lib/x86_64-linux-gnu',
  '/usr/lib/aarch64-linux-gnu',
  '/usr/lib64',
  '/usr/lib',
  '/lib/x86_64-linux-gnu',
  '/lib/aarch64-linux-gnu',
];

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function readLoginctlDisplay(): string | undefined {
  try {
    const sessions = execSync('loginctl list-sessions --no-legend', { encoding: 'utf8', stdio: 'pipe' }).trim();
    const firstSession = sessions
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .find(Boolean);
    if (!firstSession) return undefined;

    const details = execSync(`loginctl show-session ${firstSession} -p Display --value`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return details || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort DISPLAY / Wayland / DBus discovery for IDE and SSH shells. */
export function resolveLinuxGuiEnvironment(): GuiEnvironmentResolution | null {
  if (process.platform !== 'linux') return null;

  if (hasEnvValue('DISPLAY') || hasEnvValue('WAYLAND_DISPLAY')) {
    return { env: {}, source: 'existing session environment' };
  }

  const env: Record<string, string> = {};
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runUserDir = `/run/user/${uid}`;

  if (existsSync('/tmp/.X11-unix')) {
    const sockets = readdirSync('/tmp/.X11-unix')
      .filter((name) => /^X\d+$/.test(name))
      .sort();
    const firstSocket = sockets[0];
    if (firstSocket) {
      env.DISPLAY = `:${firstSocket.slice(1)}`;
    }
  }

  if (!env.DISPLAY) {
    const loginctlDisplay = readLoginctlDisplay();
    if (loginctlDisplay) {
      env.DISPLAY = loginctlDisplay;
    }
  }

  if (!env.DISPLAY && existsSync(runUserDir)) {
    const waylandSocket = readdirSync(runUserDir).find((name) => name.startsWith('wayland-'));
    if (waylandSocket) {
      env.WAYLAND_DISPLAY = waylandSocket;
    }
  }

  if (!hasEnvValue('DBUS_SESSION_BUS_ADDRESS') && existsSync(path.join(runUserDir, 'bus'))) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runUserDir, 'bus')}`;
  }

  if (Object.keys(env).length === 0) {
    return null;
  }

  const parts = [];
  if (env.DISPLAY) parts.push(`DISPLAY=${env.DISPLAY}`);
  if (env.WAYLAND_DISPLAY) parts.push(`WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}`);
  if (env.DBUS_SESSION_BUS_ADDRESS) parts.push('DBus session');
  return { env, source: parts.join(', ') };
}

function libraryPresent(soname: string): boolean {
  try {
    const ldconfig = execSync(`ldconfig -p 2>/dev/null | grep -F '${soname}' || true`, {
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: 'pipe',
    });
    if (ldconfig.includes(soname)) return true;
  } catch {
    // fall through
  }

  return LINUX_LIB_SEARCH_DIRS.some((dir) => existsSync(path.join(dir, soname)));
}

export function checkTauriDesktopPrereqs(): TauriPrereqResult {
  const issues: TauriPrereqIssue[] = [];
  let guiEnv: GuiEnvironmentResolution | null = null;

  if (process.platform === 'linux') {
    guiEnv = resolveLinuxGuiEnvironment();
    if (!guiEnv) {
      issues.push({
        code: 'missing-display',
        message: 'No graphical display is available for the Tauri desktop shell.',
        hint: 'Run from a desktop terminal, export DISPLAY=:0 (or your active X11 display), enable X11/Wayland forwarding over SSH, or open the Hub in a browser instead.',
      });
    }

    for (const lib of LINUX_LIBS) {
      if (lib.sonames.some((soname) => libraryPresent(soname))) continue;
      issues.push({
        code: 'missing-library',
        message: `${lib.label} runtime library is not installed.`,
        hint: `Install with: sudo apt-get install -y ${lib.aptPackage}`,
      });
    }
  } else if (process.platform !== 'darwin' && process.platform !== 'win32') {
    issues.push({
      code: 'unsupported-platform',
      message: `Unsupported desktop platform: ${process.platform}`,
    });
  }

  return { ok: issues.length === 0, issues, guiEnv };
}

export function buildTauriProcessEnv(guiEnv: GuiEnvironmentResolution | null): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(guiEnv?.env ?? {}),
  };
}

export function formatTauriPrereqReport(result: TauriPrereqResult, guiEnv: GuiEnvironmentResolution | null): string[] {
  const lines: string[] = [];
  if (guiEnv && Object.keys(guiEnv.env).length > 0) {
    lines.push(`Using detected GUI session (${guiEnv.source}).`);
    for (const [key, value] of Object.entries(guiEnv.env)) {
      lines.push(`${key}=${value}`);
    }
  }
  for (const issue of result.issues) {
    lines.push(issue.message);
    if (issue.hint) lines.push(issue.hint);
  }
  return lines;
}

export function hubBrowserFallbackUrl(): string {
  return process.env.CI_HUB_STACK_DEV_URL || 'http://localhost:5002';
}

export function isHeadlessOnlyFailure(result: TauriPrereqResult): boolean {
  return result.issues.length > 0 && result.issues.every((issue) => issue.code === 'missing-display');
}

export function describePlatform(): string {
  return `${os.platform()} ${os.release()}`;
}
