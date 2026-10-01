import fs from 'node:fs';

/**
 * The group the `cloudflared` container reads the tunnel token through: `nonroot`, 65532, which the
 * `cloudflare/cloudflared` image runs as (its `User` is 65532:65532). docker-entrypoint.sh adds the
 * Hub to this group when it drops privileges, which is what lets the Hub give a token it writes to
 * it, and gives the token back to it on every start. The two must agree.
 */
export const CLOUDFLARED_GID = 65532;

/**
 * The tunnel token's mode: the Hub reads and writes it, cloudflared's group reads it, and nobody
 * else can do either. The token is the whole credential for this Hub's tunnel: anyone who can read
 * it can run a connector of their own for it.
 */
export const TUNNEL_TOKEN_MODE = 0o640;

/**
 * Where the token cannot be given to cloudflared's group it stays readable by every local user, as
 * it always was, so that cloudflared, which runs as a user of its own, can still read it.
 */
const TUNNEL_TOKEN_FALLBACK_MODE = 0o644;

/**
 * Gives the tunnel token to cloudflared's group and takes it from everyone else: group
 * CLOUDFLARED_GID, mode TUNNEL_TOKEN_MODE. Returns false when that did not take, leaving the token
 * at 0644: where this process is not in the group (a backend run from a source checkout, or a
 * container whose compose pins `user:`, so the entrypoint never drops it into the group), and on a
 * mount that keeps no groups or modes (a Windows folder through Docker Desktop).
 *
 * The group goes first and the mode only once the group has taken, as docker-entrypoint.sh does it,
 * so a token cloudflared can read stays readable to it at every step, and none is left 0640 in a
 * group cloudflared is not in.
 */
export async function shareTunnelTokenWithCloudflared(tokenPath: string, gid = CLOUDFLARED_GID): Promise<boolean> {
  try {
    // -1 keeps the owner: this is a chgrp, which needs no privilege for a group the process is in.
    await fs.promises.chown(tokenPath, -1, gid);
    if ((await fs.promises.stat(tokenPath)).gid === gid) {
      await fs.promises.chmod(tokenPath, TUNNEL_TOKEN_MODE);
      if (((await fs.promises.stat(tokenPath)).mode & 0o777) === TUNNEL_TOKEN_MODE) {
        return true;
      }
    }
  } catch {
    // EPERM when this process is not in the group. The fallback below is the answer either way.
  }

  try {
    await fs.promises.chmod(tokenPath, TUNNEL_TOKEN_FALLBACK_MODE);
  } catch {
    // Not this process's file, so its mode is not this process's to change. It stays as it is.
  }
  return false;
}
