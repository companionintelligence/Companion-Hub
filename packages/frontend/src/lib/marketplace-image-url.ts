import { client } from '@/api-client/client.gen';

export function getMarketplaceAppImagePath(urn: string): string {
  return `/api/marketplace/apps/${encodeURIComponent(urn)}/image`;
}

export function getMarketplaceAppImageUrl(urn?: string): string {
  if (!urn) {
    return '/app-not-found.jpg';
  }

  const baseUrl = client.getConfig().baseUrl ?? '';
  return `${baseUrl}${getMarketplaceAppImagePath(urn)}`;
}
