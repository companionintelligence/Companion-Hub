import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function limitText(text: string, limit: number): string {
  return text.length > limit ? `${text.substring(0, limit)}...` : text;
}

export function extractAppUrn(urn: string) {
  const separatorIndex = urn.indexOf(':');
  if (separatorIndex === -1) throw new Error(`Invalid App URN: ${urn}`);
  const appName = urn.substring(0, separatorIndex);
  const appStoreId = urn.substring(separatorIndex + 1);
  if (!appStoreId || !appName) throw new Error(`Invalid App URN: ${urn}`);
  return { appName, appStoreId };
}
