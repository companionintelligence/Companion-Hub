/**
 * The environment `docker compose` runs with for an app.
 *
 * Compose expands `${NAME}` in an app's compose file from its own process environment FIRST and from
 * `--env-file` second. The Hub's process holds the Hub's secrets — `JWT_SECRET`, the forward-auth
 * secret, the Postgres and RabbitMQ passwords, whatever the operator's `.env` puts there — so an app
 * spawned with the Hub's environment could name any of them in an `environment` value, a label or a
 * command (`"value": "${JWT_SECRET}"`) and receive it. `HUB_ENV_KEYS_INHERITED_BY_APPS` keeps them out
 * of the app's env file, but that file loses to the process environment, so the allowlist meant
 * nothing to an expansion.
 *
 * An app's compose therefore runs with only what the Docker CLI needs to find the plugin, the engine
 * and a registry, and every `${NAME}` it holds is answered by the app's own env file (and the
 * operator's user env file), the files the Hub wrote for it. The Hub's own stack keeps the full
 * environment: its compose reads the Hub's `.env` on purpose.
 *
 * An allowlist, for the same reason as the env-file one: the names worth withholding are whatever the
 * operator or installer put in the Hub's environment, and cannot be listed.
 */
const PASSED_TO_APP_COMPOSE = new Set(
  [
    // Finding the binary and the plugin (`$DOCKER_CONFIG/cli-plugins`, else `$HOME/.docker`).
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    // Reaching the engine.
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_API_VERSION',
    'DOCKER_DEFAULT_PLATFORM',
    'DOCKER_BUILDKIT',
    'BUILDKIT_PROGRESS',
    // Reaching a registry or a build context through the operator's proxy and CA.
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    // A Hub run from source on Windows: Node cannot start a child without these.
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
  ].map((name) => name.toUpperCase()),
);

/**
 * `source` with only the names {@link PASSED_TO_APP_COMPOSE} lists. Names compare without case, so
 * `http_proxy` passes beside `HTTP_PROXY` and Windows' `Path` beside `PATH`.
 */
export function appComposeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && PASSED_TO_APP_COMPOSE.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return env;
}
