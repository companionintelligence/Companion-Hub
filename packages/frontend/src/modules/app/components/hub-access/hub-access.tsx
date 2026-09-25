import { client } from '@/api-client/client.gen';
import { ScopeBadge } from '@/components/scope-badge/scope-badge';
import { Button } from '@/components/ui/Button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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

interface HubAccessProps {
  appUrn: string;
  /**
   * Set while the surrounding settings form holds unsaved edits. Rotating restarts the app, which
   * would drop those edits without ever telling the operator they were lost, so the action is
   * blocked (with a reason) rather than racing the save.
   */
  hasUnsavedChanges?: boolean;
}

/**
 * "Hub access" section of the app settings dialog: the Hub-provisioned trust material this app
 * holds (its app-scoped API key + forward-auth identity secret) and a Rotate action that revokes
 * the key, clears the secret, and restarts the app so it re-provisions fresh values. Renders
 * NOTHING for apps without any Hub trust material (most apps) and on fetch errors — this is an
 * optional operator surface, never a load-bearing part of the dialog.
 *
 * Confirmation is inline rather than a nested dialog: this renders inside the settings modal, and
 * a modal stacked on a modal competes for the same focus trap and Escape handling — dismissing the
 * confirm could take the settings dialog down with it.
 */
export const HubAccess = ({ appUrn, hasUnsavedChanges = false }: HubAccessProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

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
      toast.success(t('APP_SETTINGS_HUB_ACCESS_ROTATED'));
      await queryClient.invalidateQueries({ queryKey: hubAccessQueryKey(appUrn) });
    },
    onError: () => toast.error(t('APP_SETTINGS_HUB_ACCESS_ROTATE_ERROR')),
  });

  const status = query.data ?? null;

  // Hidden while loading, on error, and for apps that neither hold nor would receive trust material.
  if (query.isLoading || query.isError || !status || (!status.provisioned && !status.appKey)) {
    return null;
  }

  const confirmRotate = () => {
    rotate.mutate();
    setConfirming(false);
  };

  return (
    <div className="mt-4 rounded-md border border-border/60 p-3" data-testid="hub-access">
      <p className="text-sm font-medium">{t('APP_SETTINGS_HUB_ACCESS_TITLE')}</p>
      <p className="text-xs text-muted-foreground">{t('APP_SETTINGS_HUB_ACCESS_DESC')}</p>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2 text-sm">
          {status.appKey && (
            <div className="min-w-0" data-testid="hub-access-key">
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{t('APP_SETTINGS_HUB_ACCESS_KEY_LABEL')}</span>
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
            {status.identityVerification ? <ShieldCheck className="h-4 w-4 text-success" /> : <ShieldOff className="h-4 w-4" />}
            {status.identityVerification ? t('APP_SETTINGS_HUB_ACCESS_IDENTITY_ON') : t('APP_SETTINGS_HUB_ACCESS_IDENTITY_OFF')}
          </p>
        </div>

        {/* type="button" throughout: this sits inside the settings dialog, and the default submit
            type would save the form on every click of a control that is not a form field. */}
        {!confirming && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rotate.isPending || hasUnsavedChanges}
            onClick={() => setConfirming(true)}
            data-testid="hub-access-rotate"
          >
            {t('APP_SETTINGS_HUB_ACCESS_ROTATE')}
          </Button>
        )}
      </div>

      {hasUnsavedChanges && !confirming && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="hub-access-unsaved-hint">
          {t('APP_SETTINGS_HUB_ACCESS_UNSAVED')}
        </p>
      )}

      {/* Confirmation gate: rotating restarts the app, so it must not fire on a single click. */}
      {confirming && (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3" data-testid="hub-access-confirm">
          <p className="text-xs text-warning">{t('APP_SETTINGS_HUB_ACCESS_ROTATE_CONFIRM')}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              type="button"
              intent="danger"
              size="sm"
              onClick={confirmRotate}
              disabled={rotate.isPending}
              data-testid="hub-access-rotate-confirm"
            >
              {t('APP_SETTINGS_HUB_ACCESS_ROTATE')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
