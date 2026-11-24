import {
  appContextQueryKey,
  getServicesStatusOptions,
  getServicesStatusQueryKey,
  setUpServicesMutation,
  turnOffServicesMutation,
} from '@/api-client/@tanstack/react-query.gen';
import type { TailscaleServicesStatusDto } from '@/api-client/types.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Network } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Detail, DetailGrid, LoadingCard, SectionHeader, StatusBadge } from '../components/network-section/network-section';

const TRUST_CREDENTIALS_URL = 'https://login.tailscale.com/admin/settings/trust-credentials';
const ACCESS_CONTROLS_URL = 'https://login.tailscale.com/admin/acls/file';

/** The one policy-file line the operator must add: who may hand the Hub's tag out. */
const tagOwnersSnippet = (tag: string) => `"tagOwners": {\n  "${tag}": ["autogroup:admin"]\n}`;

/** Whatever the API answered: a Nest error body carries `message`, a thrown Error too. */
function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (Array.isArray(message)) return message.join(' ');
    if (typeof message === 'string') return message;
  }
  return String(error);
}

const BLOCKER_KEYS: Record<NonNullable<TailscaleServicesStatusDto['blocker']>, string> = {
  'not-set-up': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_NOT_SET_UP',
  'node-not-running': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_NODE_NOT_RUNNING',
  'node-signed-out': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_NODE_SIGNED_OUT',
  'node-not-tagged': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_NODE_NOT_TAGGED',
  'node-too-old': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_NODE_TOO_OLD',
  'tailnet-unknown': 'SETTINGS_NETWORK_TS_SERVICES_BLOCKER_TAILNET_UNKNOWN',
};

/**
 * Tailscale Services for Private VPN apps: each app on its own `https://<app>.<tailnet>.ts.net/`,
 * behind the Hub login, instead of a port on the Hub's address that shares cookies with every other
 * app there and skips the login. The setup is the operator's: one policy-file line and an OAuth
 * client from the Tailscale admin console. The Hub does the rest (`TailscaleServicesService`).
 */
export const TailscaleServicesSection = () => {
  const { t } = useTranslation();
  const demoMode = useDemoMode();
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tag, setTag] = useState('');
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading } = useQuery({ ...getServicesStatusOptions(), refetchInterval: 15_000 });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getServicesStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  };

  const setUp = useMutation({
    ...setUpServicesMutation(),
    onSuccess: (status) => {
      setClientSecret('');
      setShowForm(false);
      toast.success(status.ready ? t('SETTINGS_NETWORK_TS_SERVICES_SET_UP_DONE') : t('SETTINGS_NETWORK_TS_SERVICES_SET_UP_SAVED'));
      refresh();
    },
    onError: (error) => {
      toast.error(errorText(error));
    },
  });

  const turnOff = useMutation({
    ...turnOffServicesMutation(),
    onSuccess: () => {
      toast.success(t('SETTINGS_NETWORK_TS_SERVICES_TURNED_OFF'));
      refresh();
    },
    onError: (error) => {
      toast.error(errorText(error));
    },
  });

  if (isLoading || !data) {
    return <LoadingCard icon={Network} title={t('SETTINGS_NETWORK_TS_SERVICES_TITLE')} />;
  }

  const shownTag = tag.trim() || data.tag;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setUp.mutate({ body: { clientId: clientId.trim(), clientSecret: clientSecret.trim(), ...(tag.trim() ? { tag: tag.trim() } : {}) } });
  };
  const formOpen = !data.configured || showForm;

  return (
    <Card data-testid="tailscale-services-card">
      <SectionHeader
        icon={Network}
        title={t('SETTINGS_NETWORK_TS_SERVICES_TITLE')}
        description={t('SETTINGS_NETWORK_TS_SERVICES_SUBTITLE')}
        badge={
          <StatusBadge
            connected={data.ready}
            label={
              data.ready
                ? t('SETTINGS_NETWORK_ACTIVE')
                : data.configured
                  ? t('SETTINGS_NETWORK_TS_SERVICES_NOT_WORKING')
                  : t('SETTINGS_NETWORK_TS_SERVICES_NOT_SET_UP')
            }
          />
        }
        actions={
          data.configured ? (
            <div className="flex gap-2">
              {!showForm && (
                <Button type="button" size="sm" variant="outline" disabled={demoMode} onClick={() => setShowForm(true)}>
                  {t('SETTINGS_NETWORK_TS_SERVICES_CHANGE')}
                </Button>
              )}
              {data.savedInHub && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={demoMode}
                  loading={turnOff.isPending}
                  onClick={() => turnOff.mutate({})}
                  data-testid="tailscale-services-turn-off"
                >
                  {t('SETTINGS_NETWORK_TS_SERVICES_TURN_OFF')}
                </Button>
              )}
            </div>
          ) : null
        }
      />
      <CardContent className="space-y-3">
        {!data.ready && (
          <p
            className={
              data.configured ? 'rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning' : 'text-sm text-muted-foreground'
            }
            data-testid="tailscale-services-blocker"
          >
            {t(BLOCKER_KEYS[data.blocker ?? 'not-set-up'], { tag: data.tag })}
          </p>
        )}

        {data.configured && (
          <DetailGrid>
            {data.node.nodeFqdn && <Detail label={t('SETTINGS_NETWORK_TS_SERVICES_NODE')} value={data.node.nodeFqdn} mono />}
            <Detail label={t('SETTINGS_NETWORK_TS_SERVICES_TAG')} value={data.tag} mono />
          </DetailGrid>
        )}

        {data.services.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="tailscale-services-list">
            {data.services.map((service) => (
              <li key={service.appUrn} className="flex min-w-0 items-center gap-2">
                <span className="truncate text-muted-foreground">{service.appUrn.split(':')[0]}</span>
                <a className="truncate font-mono text-xs underline" href={service.url} target="_blank" rel="noreferrer">
                  {service.url}
                </a>
              </li>
            ))}
          </ul>
        )}

        {formOpen && (
          <form className="space-y-3" onSubmit={submit} data-testid="tailscale-services-form">
            <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
              <li>
                {t('SETTINGS_NETWORK_TS_SERVICES_STEP_TAG_OWNER')}{' '}
                <a className="inline-flex items-center gap-1 underline" href={ACCESS_CONTROLS_URL} target="_blank" rel="noreferrer">
                  {t('SETTINGS_NETWORK_TS_SERVICES_OPEN_ACCESS_CONTROLS')}
                  <ExternalLink className="size-3" />
                </a>
                <pre className="mt-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono">{tagOwnersSnippet(shownTag)}</pre>
              </li>
              <li>
                {t('SETTINGS_NETWORK_TS_SERVICES_STEP_OAUTH_CLIENT', { tag: shownTag })}{' '}
                <a className="inline-flex items-center gap-1 underline" href={TRUST_CREDENTIALS_URL} target="_blank" rel="noreferrer">
                  {t('SETTINGS_NETWORK_TS_SERVICES_OPEN_TRUST_CREDENTIALS')}
                  <ExternalLink className="size-3" />
                </a>
              </li>
              <li>{t('SETTINGS_NETWORK_TS_SERVICES_STEP_PASTE')}</li>
            </ol>
            <Input
              label={t('SETTINGS_NETWORK_TS_SERVICES_CLIENT_ID')}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              disabled={demoMode || setUp.isPending}
              data-testid="tailscale-services-client-id"
            />
            <PasswordInput
              label={t('SETTINGS_NETWORK_TS_SERVICES_CLIENT_SECRET')}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoComplete="off"
              placeholder="tskey-client-…"
              disabled={demoMode || setUp.isPending}
              data-testid="tailscale-services-client-secret"
            />
            <Input
              label={t('SETTINGS_NETWORK_TS_SERVICES_TAG')}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder={data.tag}
              autoComplete="off"
              disabled={demoMode || setUp.isPending}
              data-testid="tailscale-services-tag"
            />
            <p className="text-xs text-muted-foreground">{t('SETTINGS_NETWORK_TS_SERVICES_SIGN_IN_NOTE')}</p>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={demoMode || !clientId.trim() || !clientSecret.trim()}
                loading={setUp.isPending}
                data-testid="tailscale-services-set-up"
              >
                {t('SETTINGS_NETWORK_TS_SERVICES_SET_UP')}
              </Button>
              {data.configured && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                  {t('COMMON_CANCEL')}
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
};
