import { client } from '@/api-client/client.gen';
import { Button } from '@/components/ui/Button/Button';
import { Card, CardContent } from '@/components/ui/Card/Card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** Mirrors the backend MemoryConnectUiStatus (GET /api/memory-connect/apps/:urn/status). */
interface MemoryConnectionStatus {
  applicable: boolean;
  memoryInstalled: boolean;
  state: 'unconfigured' | 'connected' | 'skipped' | 'manual';
  connectUrl: string | null;
}

const memoryStatusQueryKey = (appUrn: string) => ['memory-connection-status', appUrn];

/**
 * App-detail card showing the app's Companion Memory connection and offering
 * Connect / Disconnect. Renders nothing unless the app is a memory consumer
 * (`applicable`), so non-memory apps are unaffected. The connect action is a
 * full-page navigation into the Hub launcher (which drives the consent flow);
 * disconnect revokes + clears via the backend.
 */
export function MemoryConnectionCard({ appUrn }: { appUrn: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: memoryStatusQueryKey(appUrn),
    queryFn: async () => {
      // throwOnError: the generated client resolves (not rejects) on non-2xx by
      // default, which would mask a failed status fetch as `data: undefined`.
      const { data } = await client.get({ url: `/api/memory-connect/apps/${encodeURIComponent(appUrn)}/status`, throwOnError: true });
      return (data ?? null) as MemoryConnectionStatus | null;
    },
    staleTime: 15_000,
  });

  const disconnect = useMutation({
    // throwOnError so a non-2xx disconnect rejects into onError instead of
    // silently firing the success toast while the app stays connected.
    mutationFn: () => client.post({ url: `/api/memory-connect/apps/${encodeURIComponent(appUrn)}/disconnect`, throwOnError: true }),
    onSuccess: async () => {
      toast.success(t('MEMORY_CONNECT_DISCONNECTED_TOAST'));
      await queryClient.invalidateQueries({ queryKey: memoryStatusQueryKey(appUrn) });
    },
    onError: () => toast.error(t('MEMORY_CONNECT_DISCONNECT_ERROR')),
  });

  // Not a memory-consumer app (or still loading the first time) → render nothing.
  if (isLoading || !data?.applicable) {
    return null;
  }

  const connected = data.state === 'connected';

  const handleConnect = () => {
    if (!data.connectUrl) {
      return;
    }

    // Return to this app-detail page after the connection is applied.
    window.location.href = `${data.connectUrl}&next=${encodeURIComponent(window.location.href)}`;
  };

  return (
    <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
      <CardContent className="flex flex-col gap-3 p-3 sm:p-6">
        <div className="flex items-center gap-2">
          <BrainCircuit className="size-5 text-muted-foreground" aria-hidden />
          <h3 className="font-semibold">{t('MEMORY_CONNECT_TITLE')}</h3>
          <span
            className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${
              connected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted text-muted-foreground'
            }`}
          >
            {connected ? t('MEMORY_CONNECT_STATUS_CONNECTED') : t('MEMORY_CONNECT_STATUS_NOT_CONNECTED')}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">{t('MEMORY_CONNECT_DESC')}</p>

        {connected ? (
          <Button variant="outline" className="self-start" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            {t('MEMORY_CONNECT_ACTION_DISCONNECT')}
          </Button>
        ) : data.memoryInstalled ? (
          <Button className="self-start" disabled={!data.connectUrl} onClick={handleConnect}>
            {t('MEMORY_CONNECT_ACTION_CONNECT')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground italic">{t('MEMORY_CONNECT_NOT_INSTALLED')}</p>
        )}
      </CardContent>
    </Card>
  );
}
