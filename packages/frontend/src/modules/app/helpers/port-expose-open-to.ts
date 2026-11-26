import { isPortExposeApp, requiresHubLogin } from '@ci-hub/common/schemas';
import type { AppInfo } from '@/types/app.types';

/** Who can open an exposed port without the Hub asking them to sign in. */
export type PortExposeOpenTo = 'anyone' | 'tailnet';

/**
 * What the Hub says about an open port: `label` beside its mode on its page, `tileLabel` on its Home
 * tile, and `detail` under the address that reaches it (`accessPoint`) in its access card.
 */
export const PORT_EXPOSE_OPEN_TO_COPY = {
  anyone: {
    label: 'PORT_EXPOSE_OPEN_TO_ANYONE',
    tileLabel: 'PORT_EXPOSE_OPEN_TO_ANYONE_NO_SIGN_IN',
    detail: 'PORT_EXPOSE_OPEN_TO_ANYONE_DETAIL',
    accessPoint: 'public',
  },
  tailnet: {
    label: 'PORT_EXPOSE_OPEN_TO_TAILNET',
    tileLabel: 'PORT_EXPOSE_OPEN_TO_TAILNET_NO_SIGN_IN',
    detail: 'PORT_EXPOSE_OPEN_TO_TAILNET_DETAIL',
    accessPoint: 'vpn',
  },
} as const satisfies Record<PortExposeOpenTo, { label: string; tileLabel: string; detail: string; accessPoint: 'public' | 'vpn' }>;

/**
 * Who can open `app` with no Hub sign-in in front of it, or `null` when the Hub's sign-in guards it
 * or the app is not an exposed port.
 *
 * An exposed port is behind the Hub sign-in like any app unless the operator switched it off
 * (`requiresHubLogin`). On Public web with it off, anyone with the address reaches it through the
 * tunnel. On the Private VPN, Tailscale Serve still sends a request straight to the port, so anyone
 * on the tailnet does whatever the setting. This Machine Only stays on this machine. A store app is
 * never one.
 *
 * Asked of `config` and the app's manifest both, as the app page asks: a save through the generic
 * config route rewrites the stored form without `kind`.
 */
export function portExposeOpenTo(
  app: { config?: unknown; exposureMode?: string | null; enableAuth?: boolean | null } | null | undefined,
  info: Pick<AppInfo, 'kind'> | null | undefined,
): PortExposeOpenTo | null {
  if (!app) {
    return null;
  }

  if (!isPortExposeApp(app.config as Pick<AppInfo, 'kind'> | undefined) && !isPortExposeApp(info)) {
    return null;
  }

  switch (app.exposureMode) {
    case 'cloudflare':
      return requiresHubLogin(app) ? null : 'anyone';
    case 'tailscale':
      return 'tailnet';
    default:
      return null;
  }
}
