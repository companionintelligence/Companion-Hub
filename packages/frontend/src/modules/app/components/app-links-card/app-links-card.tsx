import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import { apiFetch } from '@/lib/api-fetch';
import { Link2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

/** One link as `GET /api/app-links` returns it (the backend's `AppLinkPlan`). */
export type AppLinkPlan = {
  consumerUrn: string;
  providerUrn: string;
  service: string;
  alias: string;
  status: 'memory' | 'mutual' | 'approved' | 'needs-approval' | 'provider-missing';
  reciprocal: boolean;
  sameStore: boolean;
};

interface Props {
  appUrn: string;
}

/**
 * The other apps this app reaches directly, and the apps that reach it (`hub_integration.links`).
 *
 * Each app is on a network of its own; two apps reach each other only over a link the Hub makes for them.
 * A link between two stores, or one only one side declared, waits for someone who manages the Hub to allow
 * it here. Renders nothing for an app with no links.
 */
export function AppLinksCard({ appUrn }: Props) {
  const { t } = useTranslation();
  const [links, setLinks] = useState<AppLinkPlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/app-links');
      if (!res.ok) return;
      setLinks((await res.json()) as AppLinkPlan[]);
    } catch {
      // The card is informational; a failed read leaves it hidden.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = useCallback(
    async (link: AppLinkPlan, allow: boolean) => {
      const key = `${link.consumerUrn}>${link.providerUrn}`;
      setBusy(key);
      try {
        const res = await apiFetch('/api/app-links/approval', {
          method: allow ? 'POST' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consumerUrn: link.consumerUrn, providerUrn: link.providerUrn }),
        });
        if (!res.ok) throw new Error(String(res.status));
        setLinks((await res.json()) as AppLinkPlan[]);
      } catch {
        toast.error(
          allow
            ? t('APP_LINKS_APPROVE_ERROR', { defaultValue: 'Could not allow this connection. Only someone who manages the Hub can.' })
            : t('APP_LINKS_REVOKE_ERROR', { defaultValue: 'Could not withdraw this connection.' }),
        );
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const mine = (links ?? []).filter((link) => link.consumerUrn === appUrn || link.providerUrn === appUrn);
  if (mine.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          {t('APP_LINKS_TITLE', { defaultValue: 'Connections to other apps' })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t('APP_LINKS_SUBTITLE', {
            defaultValue:
              'Each app runs on its own network. Two apps can reach each other only over a connection listed here, and only to the one service named.',
          })}
        </p>
        <ul className="space-y-2">
          {mine.map((link) => {
            const outgoing = link.consumerUrn === appUrn;
            const other = outgoing ? link.providerUrn : link.consumerUrn;
            const key = `${link.consumerUrn}>${link.providerUrn}`;
            return (
              <li
                key={key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {outgoing
                      ? t('APP_LINKS_REACHES', { app: other, defaultValue: `Reaches ${other}` })
                      : t('APP_LINKS_REACHED_BY', { app: other, defaultValue: `Reached by ${other}` })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <code className="font-mono">{link.service}</code>
                    {' · '}
                    {t('APP_LINKS_AS', { alias: link.alias, defaultValue: `as ${link.alias}` })}
                    {' · '}
                    {statusLabel(link, t)}
                  </div>
                </div>
                {link.status === 'needs-approval' ? (
                  <Button size="sm" variant="outline" disabled={busy === key} onClick={() => change(link, true)}>
                    {t('APP_LINKS_ALLOW', { defaultValue: 'Allow' })}
                  </Button>
                ) : link.status === 'approved' ? (
                  <Button size="sm" variant="outline" disabled={busy === key} onClick={() => change(link, false)}>
                    {t('APP_LINKS_WITHDRAW', { defaultValue: 'Withdraw' })}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function statusLabel(link: AppLinkPlan, t: (key: string, options: Record<string, unknown>) => string): string {
  switch (link.status) {
    case 'memory':
      return t('APP_LINKS_STATUS_MEMORY', { defaultValue: 'Companion Memory: on, needs a key to read anything' });
    case 'mutual':
      return t('APP_LINKS_STATUS_MUTUAL', { defaultValue: 'On: both apps ask for it' });
    case 'approved':
      return t('APP_LINKS_STATUS_APPROVED', { defaultValue: 'On: allowed by the Hub' });
    case 'provider-missing':
      return t('APP_LINKS_STATUS_MISSING', { defaultValue: 'Off: the other app is not installed' });
    default:
      return link.sameStore
        ? t('APP_LINKS_STATUS_ONE_SIDED', { defaultValue: 'Off: the other app does not ask for it. Allow it to turn it on.' })
        : t('APP_LINKS_STATUS_CROSS_STORE', { defaultValue: 'Off: the apps come from different stores. Allow it to turn it on.' });
  }
}
