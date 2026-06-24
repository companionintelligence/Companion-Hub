import { queryOptions } from '@tanstack/react-query';
import type { AvailableDomainsResponse } from '@ci-hub/common/types';

import { apiFetch } from '@/lib/api-fetch';

export const getAvailableDomainsQueryOptions = () =>
  queryOptions({
    queryKey: ['cloudflare-domains'],
    queryFn: async (): Promise<AvailableDomainsResponse> => {
      const response = await apiFetch('/api/cloudflare/domains');

      if (!response.ok) {
        throw new Error(`Failed to fetch available domains: ${response.status}`);
      }

      return response.json();
    },
    staleTime: 30000,
  });
