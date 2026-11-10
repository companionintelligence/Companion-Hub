import { isPortExposeApp } from '@ci-hub/common/schemas';
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
 * The Hub puts no sign-in in front of an exposed port, so webhooks and APIs behind one keep working.
 * On Public web anyone with the address reaches it through the tunnel. On the Private VPN, Tailscale
 * Serve sends a request straight to the port, so anyone on the tailnet does. This Machine Only stays
 * on this machine. A store app is never one: whether its Public web route asks for the Hub sign-in is
 * its own setting.
 *
 * Asked of `config` and the app's manifest both, as the app page asks: a save through the generic
 * config route rewrites the stored form without `kind`.
 */
export function portExposeOpenTo(
  app: { config?: unknown; exposureMode?: string | null } | null | undefined,
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
      return 'anyone';
    case 'tailscale':
      return 'tailnet';
    default:
      return null;
  }
}
