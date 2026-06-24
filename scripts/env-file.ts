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
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trimStart().startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(line);
  const finalContent = `${lines.filter((entry, index, all) => !(index === all.length - 1 && entry === '')).join('\n')}\n`;
  writeFileSync(abs, finalContent, 'utf-8');
}
