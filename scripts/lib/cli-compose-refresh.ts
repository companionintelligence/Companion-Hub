/**
 * `cihub compose refresh` — replace an appliance's installed `docker-compose.prod.yml` with the one
 * built into this cihub, and recreate only the Hub on it.
 *
 * The installed compose is written once, by the install seed, and nothing after that updates it: a
 * `pool update` or `fleet update --hub` moves the Hub IMAGE and leaves the compose alone. A compose
 * fix therefore reached no node that was already installed. `init: true` (the Hub is PID 1 with no
 * SIGTERM handler, so `docker restart` waited out the 10 s grace and was SIGKILLed) was applied by
 * hand with sed on core-2 on 2026-10-03 for exactly that reason.
 *
 * The seed is not a way to refresh it: it also rewrites the env file with new JWT, database and
 * RabbitMQ secrets. This command never reads or writes the env file.
 *
 * Dry run by default. `--execute` backs the file up, writes the new one, has Docker Compose resolve
 * it against the node's own env file, and puts the old one back if that fails.
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BUNDLED_HUB_COMPOSE } from './bundled-hub-assets.generated.js';
import { runCapture, run } from './cli-proc.js';
import { BASE_COMMAND } from './cli-types.js';
import { cliFail, cliOk, cliWarn, colorize, printMessageBox } from './cli-ui.js';
import { isApplianceMode } from './cli-repo-context.js';
import { resolveProdApplianceContext } from './paths.js';

export interface ComposeRefreshArgs {
  execute: boolean;
  /** Write the file and validate it, but leave the running Hub as it is. */
  recreate: boolean;
}

export function parseComposeRefreshArgs(args: string[]): ComposeRefreshArgs {
  const parsed: ComposeRefreshArgs = { execute: false, recreate: true };
  for (const arg of args) {
    if (arg === '--execute') parsed.execute = true;
    else if (arg === '--no-recreate') parsed.recreate = false;
    else throw new Error(`Unknown option for compose refresh: ${arg}`);
  }
  return parsed;
}

export interface LineChanges {
  added: string[];
  removed: string[];
}

/**
 * The lines in `next` that `current` lacks and the reverse, as multisets: enough to tell an
 * operator what a refresh changes without a diff tool on a headless box. Order is not compared, so
 * a pure reordering reads as no change.
 */
export function lineChanges(current: string, next: string): LineChanges {
  const count = (text: string): Map<string, number> => {
    const lines = new Map<string, number>();
    for (const line of text.split('\n')) lines.set(line, (lines.get(line) ?? 0) + 1);
    return lines;
  };
  const before = count(current);
  const after = count(next);
  const surplus = (from: Map<string, number>, against: Map<string, number>): string[] => {
    const out: string[] = [];
    for (const [line, n] of from) {
      for (let i = 0; i < n - (against.get(line) ?? 0); i += 1) out.push(line);
    }
    return out.filter((line) => line.trim() !== '');
  };
  return { added: surplus(after, before), removed: surplus(before, after) };
}

/** `20261003-211650`, local time, for a backup name that sorts. */
export function backupStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const MAX_SHOWN = 12;

function shown(prefix: string, lines: string[]): string[] {
  const head = lines.slice(0, MAX_SHOWN).map((line) => `  ${prefix} ${line.trim().slice(0, 100)}`);
  return lines.length > MAX_SHOWN ? [...head, `  ${prefix} … and ${lines.length - MAX_SHOWN} more`] : head;
}

export async function runComposeRefreshCommand(rawArgs: string[]): Promise<void> {
  const args = parseComposeRefreshArgs(rawArgs);
  const title = 'Compose refresh';
  if (!isApplianceMode()) {
    printMessageBox(
      title,
      [cliFail(`${BASE_COMMAND} compose refresh targets an installed appliance; this is a checkout, where the compose file is the repo's own.`)],
      'red',
    );
    process.exitCode = 1;
    return;
  }
  const ctx = resolveProdApplianceContext();
  if (!ctx.exists) {
    printMessageBox(
      title,
      [cliFail(`No installed Hub at ${ctx.dataDir} (need docker-compose.prod.yml and an env file). Run ${BASE_COMMAND} setup first.`)],
      'red',
    );
    process.exitCode = 1;
    return;
  }

  const current = readFileSync(ctx.composePath, 'utf8');
  const changes = lineChanges(current, BUNDLED_HUB_COMPOSE);
  const lines = [`${ctx.composePath}`, `compose built into this ${BASE_COMMAND}`];
  if (current === BUNDLED_HUB_COMPOSE) {
    printMessageBox(title, [...lines, '', cliOk('already identical — nothing to refresh')], 'green');
    return;
  }
  lines.push(
    '',
    `${changes.added.length} line(s) added, ${changes.removed.length} removed`,
    ...shown('+', changes.added),
    ...shown('-', changes.removed),
  );
  if (changes.added.length === 0 && changes.removed.length === 0) {
    lines.push(cliWarn('only line order or blank lines differ'));
  }
  if (!args.execute) {
    lines.push(
      '',
      colorize(`Dry run — nothing changed. Add --execute to apply${args.recreate ? ' (this also recreates the Hub container only)' : ''}.`, 'dim'),
    );
    printMessageBox(title, lines, 'cyan');
    return;
  }

  const backup = `${ctx.composePath}.bak-${backupStamp(new Date())}`;
  copyFileSync(ctx.composePath, backup);
  const staged = `${ctx.composePath}.refresh-tmp`;
  writeFileSync(staged, BUNDLED_HUB_COMPOSE, 'utf8');
  renameSync(staged, ctx.composePath);
  lines.push('', cliOk(`backed up the old file to ${backup}`));

  // Compose resolving the new file against THIS node's env file catches a variable the new compose
  // requires and the old env never had, before the running Hub is touched.
  const base = ['compose', '--env-file', ctx.envFilePath, '--project-name', 'ci-hub', '-f', ctx.composePath];
  const check = runCapture('docker', [...base, 'config', '--quiet']);
  if (!check.ok) {
    copyFileSync(backup, ctx.composePath);
    lines.push(cliFail("docker compose could not resolve the new file against this node's env file; the old one is back in place"));
    printMessageBox(title, lines, 'red');
    process.exitCode = 1;
    return;
  }
  lines.push(cliOk("docker compose resolves it against this node's env file"));

  if (!args.recreate) {
    lines.push(cliWarn('not recreated (--no-recreate): the running Hub keeps the old settings until it is recreated'));
    printMessageBox(title, lines, 'yellow');
    return;
  }
  printMessageBox(title, [...lines, '', 'Recreating the Hub container only (queue, database and apps are not touched)...'], 'cyan');
  run('docker', [...base, 'up', '-d', '--no-deps', '--force-recreate', '--no-build', 'ci-hub'], {}, ctx.dataDir);
  console.log(cliOk(`done. To undo: cp ${backup} ${ctx.composePath}, then ${BASE_COMMAND} restart`));
}
