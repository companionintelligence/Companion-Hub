import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveCanonicalDataDir } from './paths.js';

export const STATUS_FILENAME = 'CI_HUB_STATUS.md';

/** Where the Hub writes it. `state/` inside the data dir is bind-mounted from the container. */
export function statusSourcePath(dataDir = resolveCanonicalDataDir()): string {
  return path.join(dataDir, 'state', STATUS_FILENAME);
}

/**
 * Where the operator should find it.
 *
 * `~/Desktop` is not a given. `xdg-user-dirs` is often not run on a server
 * install, the directory is localised (`Escritorio`, `Schreibtisch`), and an
 * appliance brought up with `sudo cihub up` has `root` as the host user. So the
 * chain is: ask XDG, then the conventional path, and otherwise **do not invent a
 * Desktop** — fall back to the data dir, where the file still exists and the
 * caller can say where it went.
 */
function defaultXdgDesktopLookup(): string | null {
  try {
    const out = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resolveDesktopDir(options: { home?: string; xdgLookup?: () => string | null } = {}): string | null {
  const home = options.home ?? homedir();

  // `??` would be wrong here: a lookup that legitimately answers `null` must not
  // fall through and shell out anyway.
  const lookup = options.xdgLookup ?? defaultXdgDesktopLookup;
  const xdg = lookup();

  // xdg-user-dir answers with $HOME when no Desktop is configured, which is not a
  // Desktop and must not be treated as one.
  if (xdg && xdg !== home && existsSync(xdg)) {
    return xdg;
  }

  const conventional = path.join(home, 'Desktop');
  if (existsSync(conventional)) {
    return conventional;
  }

  return null;
}

export type StatusDeliveryResult =
  | { ok: true; target: string; onDesktop: boolean; generatedAt: string | null; ageMinutes: number | null }
  | { ok: false; reason: string };

/** Read the `_Generated <iso> by ...` line the renderer writes, so staleness is reportable. */
export function parseGeneratedAt(markdown: string): string | null {
  const match = markdown.match(/^_Generated (\S+) by /m);
  return match?.[1] ?? null;
}

export function ageMinutes(generatedAt: string | null, now: Date): number | null {
  if (!generatedAt) return null;
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

/**
 * Copy the Hub-written status file to the Desktop.
 *
 * Deliberately a copy of a file the Hub already wrote, not a fresh render: every
 * service that knows the answers lives in the backend process, and the CLI holds
 * no credential for the guarded routes that expose them.
 */
export function deliverStatusFile(
  options: {
    source?: string;
    desktopDir?: string | null;
    now?: Date;
    readFile?: (p: string) => string;
    copy?: (from: string, to: string) => void;
  } = {},
): StatusDeliveryResult {
  const source = options.source ?? statusSourcePath();

  if (!existsSync(source)) {
    return {
      ok: false,
      reason: `no status file at ${source} — the Hub writes it every 15 minutes, so a missing one means the Hub has not run since this was installed`,
    };
  }

  const desktop = options.desktopDir === undefined ? resolveDesktopDir() : options.desktopDir;
  const target = desktop ? path.join(desktop, STATUS_FILENAME) : source;
  const now = options.now ?? new Date();

  let generatedAt: string | null = null;
  try {
    const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    generatedAt = parseGeneratedAt(read(source));
  } catch {
    // The timestamp is a courtesy in the CLI's own output; failing to read it
    // must not stop the copy that is the point of the command.
  }

  if (desktop) {
    try {
      mkdirSync(desktop, { recursive: true });
      const copy = options.copy ?? ((from: string, to: string) => copyFileSync(from, to));
      copy(source, target);
    } catch (error) {
      return { ok: false, reason: `could not write ${target}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { ok: true, target, onDesktop: Boolean(desktop), generatedAt, ageMinutes: ageMinutes(generatedAt, now) };
}

/** Freshness the caller can act on without re-deriving the threshold. */
export function isStale(minutes: number | null, thresholdMinutes = 45): boolean {
  return minutes !== null && minutes > thresholdMinutes;
}

export function statusFileMtime(target: string): Date | null {
  try {
    return statSync(target).mtime;
  } catch {
    return null;
  }
}

/**
 * `cihub status --write-status-file` — copy the Hub's status file to the Desktop.
 *
 * Run by the systemd timer, and by hand when someone wants it now. Exits non-zero
 * when it could not deliver, so the timer's own failure state is honest.
 */
export function runWriteStatusFile(print: (line: string) => void = console.log): number {
  const result = deliverStatusFile();

  if (!result.ok) {
    print(`CI_HUB_STATUS.md not written: ${result.reason}`);
    return 1;
  }

  const age = result.ageMinutes === null ? 'age unknown' : `${result.ageMinutes} min old`;
  print(`CI_HUB_STATUS.md -> ${result.target} (${age})`);

  if (!result.onDesktop) {
    print('No Desktop directory on this machine, so the file was left where the Hub writes it.');
  }

  if (isStale(result.ageMinutes)) {
    // The copy succeeded; what it contains is what a possibly-dead Hub last knew.
    print('This report is stale — the Hub has not refreshed it recently. Check: cihub status');
  }

  return 0;
}
