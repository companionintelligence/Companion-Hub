/**
 * Private VPN (Headscale) feature flags and tunnel hostname helpers.
 * Used by HeadscaleService and Cloudflare sync so server_url and tunnel routes stay aligned.
 */

export function isPrivateVpnEnabled(): boolean {
  return process.env.PRIVATE_VPN_ENABLED !== 'false';
}

/** Container port cloudflared reaches on the Docker network (Headscale HTTP API). Default 8080. */
export function headscaleTunnelContainerPort(): number {
  const p = Number.parseInt(process.env.HEADSCALE_TUNNEL_PORT ?? '8080', 10);
  return Number.isFinite(p) && p > 0 ? p : 8080;
}

export type HeadscaleTunnelOrg = { slug: string; hubSubdomain?: string | null };

/**
 * Public FQDN for Headscale when exposed via Cloudflare tunnel (matches sync payload originServerName).
 * Pattern: vpn-{device}-{org}.{domain} or vpn-{org}.{domain} when no device slug.
 */
export function buildHeadscaleTunnelFqdn(org: HeadscaleTunnelOrg | null | undefined, publicDomain: string | undefined | null): string | null {
  if (!isPrivateVpnEnabled() || !org?.slug || !org?.hubSubdomain || !publicDomain?.trim()) return null;
  const orgSlug = org.slug;
  const normalized = org.hubSubdomain.replace(/^hub-/, '');
  const deviceSlug = normalized.endsWith(`-${orgSlug}`) ? normalized.slice(0, -(orgSlug.length + 1)) : normalized;
  const host =
    deviceSlug && deviceSlug !== orgSlug ? `vpn-${deviceSlug}-${orgSlug}.${publicDomain.trim()}` : `vpn-${orgSlug}.${publicDomain.trim()}`;
  return host;
}
