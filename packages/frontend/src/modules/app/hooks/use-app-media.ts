import { getAppMediaOptions } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { useQuery } from '@tanstack/react-query';

function resolveMediaUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  const baseUrl = client.getConfig().baseUrl ?? '';
  return `${baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

export function useAppMedia(appUrn: string | undefined, enabled: boolean) {
  return useQuery({
    ...getAppMediaOptions({
      path: { urn: appUrn ?? '' },
    }),
    enabled: Boolean(appUrn) && enabled,
    staleTime: 5 * 60_000,
    retry: 1,
    select: (data) => ({
      screenshots: (data.screenshots ?? []).map(resolveMediaUrl),
      demoVideoUrl: data.demoVideoUrl ? resolveMediaUrl(data.demoVideoUrl) : null,
    }),
  });
}
