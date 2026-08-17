import {
  getInstalledAppUrnsOptions as generatedOptions,
  getInstalledAppUrnsQueryKey as generatedQueryKey,
} from '@/api-client/@tanstack/react-query.gen';
import type { InstalledAppUrnsDto } from '@/api-client/types.gen';

export type InstalledAppUrnsResponse = InstalledAppUrnsDto;

/** Same key shape as OpenAPI codegen — keep SSE/optimistic updates aligned. */
export const getInstalledAppUrnsQueryKey = () => generatedQueryKey();

/** Separate from full getInstalledApps — store badges only need URNs. */
export const getInstalledAppUrnsOptions = () => {
  return {
    ...generatedOptions(),
    staleTime: 30_000,
  };
};
