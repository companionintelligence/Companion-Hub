import { getInstallQueue } from '@/api-client/sdk.gen';
import { unwrapSdk } from '@/lib/sdk-unwrap';

export const installQueueQueryKey = ['install-queue'] as const;

export type InstallQueueEntry = {
  urn: string;
  name: string;
};

export type InstallQueueState = {
  active: InstallQueueEntry | null;
  queued: InstallQueueEntry[];
};

export async function fetchInstallQueue(): Promise<InstallQueueState> {
  return unwrapSdk(getInstallQueue()) as Promise<InstallQueueState>;
}
