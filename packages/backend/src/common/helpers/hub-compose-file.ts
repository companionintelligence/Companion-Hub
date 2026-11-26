import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, DATA_DIR } from '@/common/constants';

/**
 * The Docker Compose file the Hub's own stack services (`cloudflared`, `hub-tailscale`) start from.
 *
 * The bundled Hub mounts the active file at `${DATA_DIR}/docker-compose.yml`, matching
 * `DockerService.getBaseComposeArgsHub`. Local `pnpm dev` and tests fall back to the repository
 * source file. Do not gate the mounted path on `NODE_ENV`: inside the bundled image it is whatever
 * the env file passes through (docker-compose.prod.yml defaults it to production), and
 * `development` there would select the nonexistent `/app/docker-compose.local.yml`.
 */
export function resolveHubComposeFile(): string {
  const mounted = path.join(DATA_DIR, 'docker-compose.yml');
  if (fsSync.existsSync(mounted)) {
    return mounted;
  }

  const isLocal = process.env.LOCAL === 'true' || process.env.NODE_ENV === 'development';
  const isStaging = process.env.NODE_ENV === 'staging';

  let filename = 'docker-compose.prod.yml';
  if (isLocal) {
    filename = 'docker-compose.local.yml';
  } else if (isStaging) {
    filename = 'docker-compose.staging.yml';
  }

  return path.join(APP_DIR, filename);
}
