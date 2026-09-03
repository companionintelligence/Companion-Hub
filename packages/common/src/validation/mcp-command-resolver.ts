/**
 * Resolve `${VAR}`, `${VAR:-default}`, and `${ENV:KEY}` placeholders in MCP command/args
 * using an installed app's env map (from app.env after install).
 */
export function resolveMcpTemplateString(template: string, env: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, raw: string) => {
    const varName = raw.trim();

    if (varName.startsWith('ENV:')) {
      const key = varName.slice(4);
      return env[key] ?? match;
    }

    const defaultMatch = varName.match(/^([^:-]+):-(.*)$/);
    if (defaultMatch) {
      const [, key, defaultVal] = defaultMatch;
      const resolved = env[key ?? ''];
      return resolved !== undefined && resolved !== '' ? resolved : (defaultVal ?? '');
    }

    return env[varName] ?? match;
  });
}

/** Expand template placeholders in each MCP exec argv segment. */
export function resolveMcpCommandParts(command: string, args: string[], env: Record<string, string>): string[] {
  return [resolveMcpTemplateString(command, env), ...args.map((arg) => resolveMcpTemplateString(arg, env))];
}
