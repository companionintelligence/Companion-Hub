import type { AppUrn } from '@ci-hub/common/types';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import { FORWARD_AUTH_SECRET_ENV } from '@/modules/auth/forward-auth-secret.resolver';
import type { EnvUtils } from '@/modules/env/env.utils';

/**
 * The key the Hub and one Companion Memory sign their connect calls with: Memory's own
 * `CI_HUB_FORWARD_AUTH_SECRET`, from that install's app.env. Null when it has none, or still holds
 * the Hub-wide `forwardAuthSecret` (an env written before Memory got a key of its own; the next env
 * generation replaces it).
 *
 * Both directions use it: the Hub's code exchange, rotation and revocation calls to Memory
 * (`MemoryExchangeClient`), and Memory's doorbell to the Hub (`AgentNotifyController`). They used
 * to be keyed on the Hub-wide secret, which env generation copied into Memory, so anything that
 * reached inside a Memory container held a key the Hub's own endpoints also took (2026-11-20 audit).
 * Memory reads this same variable for both, so a Memory of any version agrees with it.
 */
export async function memoryConnectSecret(
  appFilesManager: Pick<AppFilesManager, 'getAppEnv'>,
  envUtils: Pick<EnvUtils, 'envStringToMap'>,
  hubWideSecret: string | null | undefined,
  appUrn: AppUrn,
): Promise<string | null> {
  const env = envUtils.envStringToMap((await appFilesManager.getAppEnv(appUrn)).content);
  const own = (env.get(FORWARD_AUTH_SECRET_ENV) ?? '').trim();

  if (!own || own === (hubWideSecret ?? '').trim()) {
    return null;
  }

  return own;
}
