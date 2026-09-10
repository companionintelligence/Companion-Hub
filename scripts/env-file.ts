import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(abs, `${lines.join('\n')}\n`, 'utf-8');
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
  writeFileSync(abs, `${kept.filter((entry, index, all) => !(index === all.length - 1 && entry === '')).join('\n')}\n`, 'utf-8');
}
