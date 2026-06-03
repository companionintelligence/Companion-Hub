import { apiFetch } from '@/lib/api-fetch';

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
  const res = await apiFetch('/api/apps/install-queue', { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to load install queue (${res.status})`);
  }
  return (await res.json()) as InstallQueueState;
}
