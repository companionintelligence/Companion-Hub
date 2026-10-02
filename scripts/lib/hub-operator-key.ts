/**
 * The operator bearer a fleet script presents to the Hub it is running on.
 *
 * Every fleet script that drives the Hub API from inside an ssh session (`fleet backends`' context cap
 * and slot writes, `fleet update --models recommended`, the llama-server auto-model lookup) reads the
 * credential out of the node's own `state/settings.json`. It must read `hubLocalKey` first. Since the
 * Hub-minted Portal push key (#1612) the Hub accepts the Portal device key, `ciHubApiKey`, as an
 * operator bearer only until Portal has confirmed that push key; on every Hub past that point a
 * request carrying it, read or write, answers 401 `SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN`. `hubLocalKey`
 * is minted into the same file at boot for exactly this caller, a process on the box, and is accepted
 * as `host-local`. A Hub that predates it has no such key and still accepts the device key, so that
 * stays the fallback.
 */

/** Shell-quotes nothing: the settings path arrives already escaped for single quotes by each caller. */
function sedRead(key: string, hostSettings: string): string {
  return `sed -n 's/.*"${key}"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' '${hostSettings}' | head -1`;
}

/**
 * Shell lines that leave the operator bearer in `$<name>` (empty when none is readable). Prefers the
 * running container's copy, then the host data dir's; within each, `hubLocalKey` before `ciHubApiKey`.
 *
 * @param name         the shell variable to fill, e.g. `key`
 * @param hostSettings the host path of `state/settings.json`, already escaped for single quotes
 */
export function hubOperatorKeyShell(name: string, hostSettings: string): string[] {
  return [
    `${name}=""`,
    "if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ci-hub; then",
    // `node -e` rather than grep/sed: a JSON value can legally carry escapes a regex would truncate.
    `  ${name}="$(docker exec ci-hub node -e 'try{const s=require("/data/state/settings.json");process.stdout.write(String(s.hubLocalKey||s.ciHubApiKey||""))}catch{}' 2>/dev/null)"`,
    'fi',
    `if [ -z "$${name}" ] && [ -r '${hostSettings}' ]; then`,
    `  ${name}="$(${sedRead('hubLocalKey', hostSettings)})"`,
    `  [ -n "$${name}" ] || ${name}="$(${sedRead('ciHubApiKey', hostSettings)})"`,
    'fi',
  ];
}
