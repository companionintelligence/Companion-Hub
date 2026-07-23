import { client } from '@/api-client/client.gen';
import { ScopeBadge } from '@/components/scope-badge/scope-badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** Mirrors the backend hub-access view (GET /api/app-lifecycle/:urn/hub-access). Never carries raw values. */
export interface HubAccessStatus {
  appKey: { prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string } | null;
  /** Whether a per-app forward-auth secret is provisioned (in-app identity verification active). */
  identityVerification: boolean;
  /** Whether this app would be (re-)provisioned trust material on its next env generation. */
  provisioned: boolean;
}

export const hubAccessQueryKey = (appUrn: string) => ['app-hub-access', appUrn];

/**
 * Compact "Hub access" card for the app-detail page: the Hub-provisioned trust material this app
 * holds (its app-scoped API key + forward-auth identity secret) and a Rotate action that revokes
 * the key, clears the secret, and restarts the app so it re-provisions fresh values. Renders
 * NOTHING for apps without any Hub trust material (most apps) and on fetch errors — this is an
 * optional operator surface, never a load-bearing part of the page.
 */
export const HubAccess = ({ appUrn }: { appUrn: string }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const query = useQuery({
    queryKey: hubAccessQueryKey(appUrn),
    queryFn: async () => {
      // throwOnError: the generated client resolves (not rejects) on non-2xx by default, which
      // would mask a failed fetch as `data: undefined`.
      const { data } = await client.get({ url: `/api/app-lifecycle/${encodeURIComponent(appUrn)}/hub-access`, throwOnError: true });
      return (data ?? null) as HubAccessStatus | null;
    },
    staleTime: 15_000,
    retry: false,
  });

  const rotate = useMutation({
    // throwOnError so a non-2xx rotate rejects into onError instead of silently firing the
    // success toast while the app keeps its old credentials.
    mutationFn: () => client.post({ url: `/api/app-lifecycle/${encodeURIComponent(appUrn)}/hub-access/rotate`, throwOnError: true }),
    onSuccess: async () => {
      toast.success(t('APP_DETAILS_HUB_ACCESS_ROTATED'));
      await queryClient.invalidateQueries({ queryKey: hubAccessQueryKey(appUrn) });
    },
    onError: () => toast.error(t('APP_DETAILS_HUB_ACCESS_ROTATE_ERROR')),
  });

  const status = query.data ?? null;

  // Hidden while loading, on error, and for apps that neither hold nor would receive trust material.
  if (query.isLoading || query.isError || !status || (!status.provisioned && !status.appKey)) {
    return null;
  }

  const confirmRotate = () => {
    rotate.mutate();
    setConfirmOpen(false);
  };

  return (
    <Card className="border-border/60 bg-card/80 shadow-sm" data-testid="hub-access">
      <CardHeader className="px-3 pb-3 pt-3 sm:px-6 sm:pb-4 sm:pt-6">
        <CardTitle className="text-lg">{t('APP_DETAILS_HUB_ACCESS_TITLE')}</CardTitle>
        <CardDescription>{t('APP_DETAILS_HUB_ACCESS_DESC')}</CardDescription>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0 sm:px-6 sm:pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2 text-sm">
            {status.appKey && (
              <div className="min-w-0" data-testid="hub-access-key">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{t('APP_DETAILS_HUB_ACCESS_KEY_LABEL')}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{status.appKey.prefix}…</code>
                  {status.appKey.scopes.map((scope) => (
                    <ScopeBadge key={scope} scope={scope} />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {status.appKey.lastUsedAt
                    ? t('API_KEYS_LAST_USED', { when: new Date(status.appKey.lastUsedAt).toLocaleString() })
                    : t('API_KEYS_NEVER_USED')}
                </p>
              </div>
            )}
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {status.identityVerification ? (
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ShieldOff className="h-4 w-4" />
              )}
              {status.identityVerification ? t('APP_DETAILS_HUB_ACCESS_IDENTITY_ON') : t('APP_DETAILS_HUB_ACCESS_IDENTITY_OFF')}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={rotate.isPending} onClick={() => setConfirmOpen(true)} data-testid="hub-access-rotate">
            {t('APP_DETAILS_HUB_ACCESS_ROTATE')}
          </Button>
        </div>
      </CardContent>

      {/* Confirmation gate: rotating restarts the app, so it must not fire on a single click. */}
      <Dialog open={confirmOpen} onOpenChange={(open) => !open && setConfirmOpen(false)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('APP_DETAILS_HUB_ACCESS_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <span className="text-muted-foreground">{t('APP_DETAILS_HUB_ACCESS_ROTATE_CONFIRM')}</span>
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button intent="danger" onClick={confirmRotate} disabled={rotate.isPending} data-testid="hub-access-rotate-confirm">
              {t('APP_DETAILS_HUB_ACCESS_ROTATE')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
