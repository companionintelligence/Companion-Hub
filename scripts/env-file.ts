import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function parseEnvFile(envFileName: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const envPath = isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);

  try {
    const fileContent = readFileSync(envPath, 'utf-8');
    for (const line of fileContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // Missing or unreadable env file — treat as empty.
  }

  return vars;
}

/**
 * Owner read and write only. A Hub env file holds JWT_SECRET, POSTGRES_PASSWORD and
 * RABBITMQ_PASSWORD; seed-appliance creates it at this mode and the container reads it as its owner.
 */
const ENV_FILE_MODE = 0o600;

/**
 * Clear the group and other bits on an env file this user owns. Never adds any: a 0400 file stays
 * 0400. Returns the mode it replaced, or undefined when it changed nothing.
 *
 * `writeFileSync`'s `mode` applies only when it creates the file, so an env file first written at the
 * umask's 0664 (by the desktop app, or by `cp .env.example`) kept that mode through every later write.
 * Only a file this user owns: taking bits off someone else's could lock its owner's Hub out of it.
 * Not one whose CI_HUB_CONTAINER_UID pins the Hub to another non-root uid either: the Hub reads
 * the file as that uid (docker-entrypoint.sh), through the group or other bits this would clear.
 */
export function restrictEnvFileMode(envFileName: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  const abs = isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) return undefined;
    const pinnedUid = (process.env.CI_HUB_CONTAINER_UID || parseEnvFile(abs).CI_HUB_CONTAINER_UID)?.trim();
    if (pinnedUid && pinnedUid !== '0' && pinnedUid !== String(stat.uid)) return undefined;
    const current = stat.mode & 0o777;
    const restricted = current & ENV_FILE_MODE;
    if (restricted === current) return undefined;
    chmodSync(abs, restricted);
    return current;
  } catch {
    // Missing, or a mount that refuses chmod: the write still goes ahead.
    return undefined;
  }
}

/** Restrict first, so the new content never lands in a file other users can read. */
function writeEnvFile(abs: string, content: string): void {
  restrictEnvFileMode(abs);
  writeFileSync(abs, content, { encoding: 'utf-8', mode: ENV_FILE_MODE });
}

export function upsertEnvVar(envFileName: string, key: string, value: string) {
  const abs = isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);
  const line = `${key}=${value}`;
  const current = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  // A file this function wrote always ends in '\n', which splits into a trailing '' element.
  // Drop it before appending a new key, or repeated calls against the same freshly-created file
  // (e.g. resolveHubPorts writing several ports in a row) accumulate a blank line between every
  // entry instead of one trailing newline at the end.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trimStart().startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(line);
  const next = `${lines.join('\n')}\n`;
  if (next === current) {
    restrictEnvFileMode(abs);
    return;
  }
  writeEnvFile(abs, next);
}

/**
 * Drop a variable from an env file, leaving everything else byte-for-byte alone.
 *
 * The counterpart to {@link upsertEnvVar}, for the case where the CORRECT value is "no
 * value": a variable whose presence pins something that a downstream consumer would
 * otherwise derive for itself. Commenting the line out would not do — compose reads the
 * file, and a commented line and an absent one are the same to it, but only an absent one
 * stops `upsertEnvVar` from later rewriting in place and resurrecting the pin.
 *
 * Matches the same `key=` prefix rule as upsertEnvVar, so the two agree on what counts as
 * the variable's line. Comments and blank lines are preserved.
 */
export function removeEnvVar(envFileName: string, key: string) {
  const abs = isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);
  if (!existsSync(abs)) return;
  const lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
  const kept = lines.filter((line) => !line.trimStart().startsWith(`${key}=`));
  if (kept.length === lines.length) return;
  writeEnvFile(abs, `${kept.filter((entry, index, all) => !(index === all.length - 1 && entry === '')).join('\n')}\n`);
}
