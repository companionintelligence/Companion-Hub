#!/usr/bin/env tsx
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { box } from './cihub-cli';
import {
  buildTauriProcessEnv,
  checkTauriDesktopPrereqs,
  formatTauriPrereqReport,
  hubBrowserFallbackUrl,
  isHeadlessOnlyFailure,
  resolveLinuxGuiEnvironment,
} from './check-tauri-desktop-prereqs';

type LaunchMode = 'stack-dev' | 'vite-dev';
const require = createRequire(import.meta.url);
const { ensureRepoCliOnPath } = require('./desktop-cli-path.cjs') as {
  ensureRepoCliOnPath: (repoRoot: string) => { messageLines: string[] };
};

function parseMode(): LaunchMode {
  return process.argv.includes('--stack-dev') ? 'stack-dev' : 'vite-dev';
}

function printBox(title: string, lines: string[], tone: 'green' | 'yellow' | 'red' | 'cyan') {
  console.log(box(title, lines, tone));
}

function launchTauriDesktop(mode: LaunchMode): number {
  const repoRoot = process.cwd();
  const desktopDir = path.join(repoRoot, 'packages/desktop');
  const prereqs = checkTauriDesktopPrereqs();
  const guiEnv = prereqs.guiEnv ?? resolveLinuxGuiEnvironment();

  if (!prereqs.ok) {
    if (mode === 'stack-dev' && isHeadlessOnlyFailure(prereqs)) {
      printBox(
        'Hub stack ready (headless)',
        [
          `The Hub API is healthy at ${hubBrowserFallbackUrl()}.`,
          'This shell has no graphical display, so the Tauri desktop window was skipped.',
          'Open that URL in a browser, or run from a desktop terminal to launch the native app.',
        ],
        'yellow',
      );
      return 0;
    }

    printBox('Desktop prerequisites', formatTauriPrereqReport(prereqs, guiEnv), 'red');
    return 1;
  }

  if (guiEnv && Object.keys(guiEnv.env).length > 0) {
    printBox('Desktop session', formatTauriPrereqReport({ ok: true, issues: [], guiEnv }, guiEnv), 'cyan');
  }

  const args = ['tauri', 'dev'];
  if (mode === 'stack-dev') {
    args.push('--no-dev-server-wait');
    args.push('--config', 'src-tauri/tauri.stack-dev.json');
  }

  const tauriEnv = {
    ...buildTauriProcessEnv(guiEnv),
    ...(mode === 'stack-dev'
      ? {
          CI_HUB_STACK_DEV: '1',
          CI_HUB_STACK_DEV_COMPOSE_PATH: path.join(repoRoot, 'docker-compose.prod.yml'),
          CI_HUB_STACK_DEV_ENV_PATH: path.join(repoRoot, '.env.dev'),
        }
      : {}),
  };

  const result = spawnSync('cargo', args, {
    cwd: desktopDir,
    env: tauriEnv,
    stdio: 'inherit',
  });

  if (result.error) {
    printBox('Failed to launch Tauri', [result.error.message], 'red');
    return 1;
  }

  if ((result.status ?? 1) === 0) {
    const cliPath = ensureRepoCliOnPath(repoRoot);
    printBox('Companion Hub CLI', cliPath.messageLines, 'green');
  }

  return result.status ?? 1;
}

process.exit(launchTauriDesktop(parseMode()));
