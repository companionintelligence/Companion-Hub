import type { GetInstalledAppsResponse } from '@/api-client';
import {
  getAppQueryKey,
  getInstalledAppsOptions,
  getInstalledAppsQueryKey,
  getLinksOptions,
  setGuestVisibilityMutation,
  updateUserSettingsMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { CustomLink } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { isLocalAppDefaultShortDesc } from '@ci-hub/common/types';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SettingsHint } from '../components/settings-hint';
import { DeleteGuestLinkDialog, GuestLinkDialog } from '../components/guest-link-dialog/guest-link-dialog';

const SET_VISIBILITY_KEY = ['guest-dashboard-settings', 'set-guest-visibility'];

/** A list that didn't load, with Retry, as Home shows when its app list fails. */
const LoadFailed = ({ onRetry }: { onRetry: () => void }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground">{t('COMMON_AN_ERROR_OCCURRED')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('COMMON_RETRY')}
      </Button>
    </div>
  );
};

/**
 * Everything about the guest dashboard in one card (#2422): whether it's on, which apps guests see and
 * the links shown beside them. The switch used to sit in General settings, the per-app choice only in
 * each app's Settings dialog with Advanced mode on, and links had no screen at all.
 */
export const GuestDashboardSettings = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { userSettings, refreshAppContext } = useAppContext();
  const enabled = Boolean(userSettings.guestDashboard);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const shown = enabledDraft ?? enabled;

  const linkDialog = useDisclosure();
  const deleteDialog = useDisclosure();
  const [editing, setEditing] = useState<CustomLink | null>(null);
  const [deleting, setDeleting] = useState<CustomLink | null>(null);

  const onError = (error: TranslatableError) => {
    toast.error(t(error.message, error.intlParams ?? {}));
  };

  // Saved on its own: settings merge on the Hub, so this leaves the rest of General settings alone.
  const updateSettings = useMutation({
    ...updateUserSettingsMutation(),
    onError: (error: TranslatableError) => {
      setEnabledDraft(null);
      onError(error);
    },
    onSuccess: async () => {
      await refreshAppContext();
      setEnabledDraft(null);
      toast.success(t('SETTINGS_GENERAL_SETTINGS_UPDATED'));
    },
  });

  const installedApps = useQuery({ ...getInstalledAppsOptions(), enabled: shown, staleTime: 30_000 });
  const links = useQuery({ ...getLinksOptions(), enabled: shown });

  // Each switch shows its new state at once and stays disabled until the Hub's list agrees. Read back from
  // the one mutation's last variables, a second switch flipped before the first answered dropped the first
  // back to its old state. Every switch also flicked back for the moment between the answer and the refetch.
  const setVisibility = useMutation({
    ...setGuestVisibilityMutation(),
    mutationKey: SET_VISIBILITY_KEY,
    onMutate: async ({ path, body }) => {
      await queryClient.cancelQueries({ queryKey: getInstalledAppsQueryKey() });
      queryClient.setQueryData<GetInstalledAppsResponse>(getInstalledAppsQueryKey(), (current) =>
        current
          ? {
              ...current,
              installed: current.installed.map((entry) =>
                entry.info.urn === path.urn ? { ...entry, app: { ...entry.app, isVisibleOnGuestDashboard: body.visible } } : entry,
              ),
            }
          : current,
      );
    },
    onError,
    onSettled: (_data, _error, { path }) => {
      // The app's own record too. Its Settings dialog opens with the stored value, and a save from a cached
      // copy, with the guest switch hidden outside Advanced mode, put the old choice back.
      void queryClient.invalidateQueries({ queryKey: getAppQueryKey({ path: { urn: path.urn } }) });
      return queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
    },
  });
  const savingUrns = useMutationState({
    filters: { mutationKey: SET_VISIBILITY_KEY, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { path: { urn: string } } | undefined)?.path.urn,
  });

  const apps = installedApps.data?.installed ?? [];
  const linkList = links.data?.links ?? [];

  return (
    <Card data-testid="guest-dashboard-settings">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 shrink-0 text-muted-foreground" />
          <CardTitle className="text-xl">{t('SETTINGS_GUEST_DASHBOARD_TITLE')}</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">{t('SETTINGS_GUEST_DASHBOARD_DESC')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Switch
          checked={shown}
          disabled={updateSettings.isPending}
          onCheckedChange={(checked) => {
            setEnabledDraft(checked);
            updateSettings.mutate({ body: { guestDashboard: checked } });
          }}
          label={
            <>
              {t('SETTINGS_GENERAL_GUEST_DASHBOARD')}
              <SettingsHint className="guest-dashboard-hint" hint={t('SETTINGS_GENERAL_GUEST_DASHBOARD_HINT')} />
            </>
          }
        />

        {shown ? (
          <>
            <section className="space-y-3 border-t border-border pt-5" aria-labelledby="guest-apps-heading">
              <div>
                <h3 id="guest-apps-heading" className="text-sm font-medium">
                  {t('SETTINGS_GUEST_DASHBOARD_APPS_TITLE')}
                </h3>
                <p className="text-sm text-muted-foreground">{t('SETTINGS_GUEST_DASHBOARD_APPS_DESC')}</p>
              </div>
              {installedApps.isPending ? (
                <p className="text-sm text-muted-foreground">{t('COMMON_LOADING')}</p>
              ) : installedApps.isError ? (
                <LoadFailed onRetry={() => void installedApps.refetch()} />
              ) : apps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('SETTINGS_GUEST_DASHBOARD_APPS_EMPTY')}</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="guest-dashboard-apps-list">
                  {apps.map(({ app, info }) => {
                    const description = info.short_desc && !isLocalAppDefaultShortDesc(info.short_desc) ? info.short_desc : null;
                    const pending = savingUrns.includes(info.urn);
                    return (
                      <li key={info.urn} className="flex items-center gap-3 px-3 py-2.5">
                        <AppLogo urn={info.urn} alt={info.name} name={info.name} size={32} className="shrink-0 rounded-md" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{info.name}</div>
                          {description ? <div className="truncate text-xs text-muted-foreground">{description}</div> : null}
                        </div>
                        <Switch
                          aria-label={t('SETTINGS_GUEST_DASHBOARD_APP_TOGGLE', { name: info.name })}
                          checked={app.isVisibleOnGuestDashboard}
                          disabled={pending}
                          onCheckedChange={(checked) => setVisibility.mutate({ path: { urn: info.urn }, body: { visible: checked } })}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="space-y-3 border-t border-border pt-5" aria-labelledby="guest-links-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="guest-links-heading" className="text-sm font-medium">
                    {t('SETTINGS_GUEST_DASHBOARD_LINKS_TITLE')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t('SETTINGS_GUEST_DASHBOARD_LINKS_DESC')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setEditing(null);
                    linkDialog.open();
                  }}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {t('GUEST_LINK_ADD')}
                </Button>
              </div>
              {links.isPending ? (
                <p className="text-sm text-muted-foreground">{t('COMMON_LOADING')}</p>
              ) : links.isError ? (
                <LoadFailed onRetry={() => void links.refetch()} />
              ) : linkList.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('SETTINGS_GUEST_DASHBOARD_LINKS_EMPTY')}</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="guest-dashboard-links-list">
                  {linkList.map((link) => (
                    <li key={link.id} className="flex items-center gap-3 px-3 py-2.5">
                      <AppLogo url={link.iconUrl || undefined} name={link.title} alt={link.title} size={32} className="shrink-0 rounded-md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{link.title}</span>
                          {link.isVisibleOnGuestDashboard ? null : (
                            <span className="shrink-0 rounded-md border border-border/70 bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground">
                              {t('SETTINGS_GUEST_DASHBOARD_LINK_HIDDEN')}
                            </span>
                          )}
                        </div>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                          <span className="truncate">{link.url}</span>
                          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                        </a>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('GUEST_LINK_EDIT_LABEL', { title: link.title })}
                          onClick={() => {
                            setEditing(link);
                            linkDialog.open();
                          }}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('GUEST_LINK_DELETE_LABEL', { title: link.title })}
                          onClick={() => {
                            setDeleting(link);
                            deleteDialog.open();
                          }}
                        >
                          <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </CardContent>

      <GuestLinkDialog isOpen={linkDialog.isOpen} onClose={linkDialog.close} link={editing} />
      <DeleteGuestLinkDialog isOpen={deleteDialog.isOpen} onClose={deleteDialog.close} link={deleting} />
    </Card>
  );
};
