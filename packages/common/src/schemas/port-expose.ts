import type { AppInfo } from './app-info.js';

export const PORT_EXPOSE_KIND = 'port-expose' as const;

export function isPortExposeApp(info: Pick<AppInfo, 'kind'> | null | undefined): boolean {
  return info?.kind === PORT_EXPOSE_KIND;
}
