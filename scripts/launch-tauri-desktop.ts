#!/usr/bin/env tsx
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { box } from './cihub-cli';
import { parseEnvFile } from './env-file';
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

/** Stack-dev WebView URL must match API_PORT in the env file (port manager may reassign it). */
function writeStackDevTauriConfig(desktopDir: string, envPath: string): string {
  const vars = parseEnvFile(envPath);
  const apiPort = vars.API_PORT?.trim() || '5002';
  const configRelPath = 'src-tauri/.tauri.stack-dev.generated.json';
  const configAbsPath = path.join(desktopDir, configRelPath);

  writeFileSync(
    configAbsPath,
    `${JSON.stringify(
      {
        $schema: 'https://schema.tauri.app/config/2',
        identifier: 'computer.ci.app.hub.dev',
        build: {
          devUrl: `http://127.0.0.1:${apiPort}`,
          beforeDevCommand: '',
        },
        plugins: {
          'deep-link': {
            desktop: {
              schemes: ['cihub-dev'],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  return configRelPath;
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

  const stackDevEnvPath = path.join(repoRoot, '.env.dev');

  const args = ['tauri', 'dev'];
  if (mode === 'stack-dev') {
    args.push('--no-dev-server-wait');
    args.push('--config', writeStackDevTauriConfig(desktopDir, stackDevEnvPath));
  }

  // This launcher only ever runs dev builds, so the Hub must target the dev portal
  // (hub.companionintelligence.com), never production (hub.ci.computer). The Rust binary
  // resolves portal URL / public domain / image tag from the compile-time CI_HUB_ENVIRONMENT
  // (see hub_env.rs: any non-"production" value → dev), and it bakes that same value into the
  // runtime .env it generates. Without this, a stray CI_HUB_ENVIRONMENT=production in the shell
  // would compile a dev desktop that points at the production portal. Honor an explicit
  // non-production override (e.g. "staging"), otherwise force "development".
  const requestedEnv = process.env.CI_HUB_ENVIRONMENT?.trim().toLowerCase();
  const ciHubEnvironment = requestedEnv && requestedEnv !== 'production' ? requestedEnv : 'development';

  const tauriEnv = {
    ...buildTauriProcessEnv(guiEnv),
    CI_HUB_ENVIRONMENT: ciHubEnvironment,
    ...(mode === 'stack-dev'
      ? {
          CI_HUB_STACK_DEV: '1',
          CI_HUB_STACK_DEV_COMPOSE_PATH: path.join(repoRoot, 'docker-compose.prod.yml'),
          CI_HUB_STACK_DEV_ENV_PATH: stackDevEnvPath,
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
