#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';

function runStep(command: string, args: string[]): { ok: boolean; code: number } {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.warn(`start-dev-desktop: failed to run ${command} ${args.join(' ')}: ${result.error.message}`);
    return { ok: false, code: 1 };
  }

  return { ok: (result.status ?? 1) === 0, code: result.status ?? 1 };
}

function main(): number {
  const stackStart = runStep('pnpm', ['run', 'start:dev:detached']);
  if (!stackStart.ok) {
    console.warn('start-dev-desktop: Hub stack did not start. Not launching Tauri because stack-dev mode requires a healthy Hub on localhost:5002.');
    return stackStart.code || 1;
  }

  const waitForHub = runStep('pnpm', ['run', 'wait:hub']);
  if (!waitForHub.ok) {
    console.warn(
      'start-dev-desktop: Hub API did not become healthy in time. Not launching Tauri because stack-dev mode would open a blank localhost page.',
    );
    return waitForHub.code || 1;
  }

  const desktop = runStep('pnpm', ['exec', 'tsx', 'scripts/launch-tauri-desktop.ts', '--stack-dev']);
  return desktop.code;
}

process.exit(main());
