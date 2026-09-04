import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import { apiFetch } from '@/lib/api-fetch';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { Copy, Plug, RefreshCw, Terminal, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Link } from 'react-router';

type McpRuntime = {
  bridgeable: boolean;
  transport?: string;
  containerStatus: 'running' | 'stopped' | 'missing' | 'unknown';
  toolCount: number;
  lastError?: string;
  lastProbeAt?: string;
  bridgeWarning?: string;
  connected: boolean;
};

interface Props {
  app?: AppDetails | null;
  info: AppInfo;
  mcpRuntime?: McpRuntime | null;
}

function bridgeStatusBadge(runtime: McpRuntime | null | undefined, installed: boolean, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (!installed) {
    return { label: t('APP_MCP_STATUS_NOT_INSTALLED', { defaultValue: 'Not installed' }), tone: 'muted' as const };
  }
  if (!runtime?.bridgeable) {
    return { label: t('APP_MCP_STATUS_NOT_BRIDGEABLE', { defaultValue: 'Not bridgeable' }), tone: 'warn' as const };
  }
  if (runtime.containerStatus !== 'running') {
    return { label: t('APP_MCP_STATUS_CONTAINER_DOWN', { defaultValue: 'Container down' }), tone: 'warn' as const };
  }
  if (runtime.connected) {
    return {
      label: t('APP_MCP_STATUS_CONNECTED', { count: runtime.toolCount, defaultValue: `Connected · ${runtime.toolCount} tools` }),
      tone: 'ok' as const,
    };
  }
  if (runtime.lastError) {
    return { label: t('APP_MCP_STATUS_NEEDS_ATTENTION', { defaultValue: 'Needs attention' }), tone: 'warn' as const };
  }
  return { label: t('APP_MCP_STATUS_UNKNOWN', { defaultValue: 'Unknown' }), tone: 'muted' as const };
}

/**
 * Access card for MCP server apps (#936). These apps are `no_gui`, so the regular
 * access-points card renders nothing — leaving a user who installed an MCP server
 * with no clue how to use it. This card fills that hole: what the server offers
 * (tool manifest from the marketplace listing), and how to reach it (the Hub MCP
 * endpoint bridges installed app servers; clients authenticate with an mcp-scoped
 * API key).
 */
export function McpAccessCard({ app, info, mcpRuntime: initialRuntime }: Props) {
  const { t } = useTranslation();
  const mcp = info.mcp;
  const [runtime, setRuntime] = useState<McpRuntime | null | undefined>(initialRuntime);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    setRuntime(initialRuntime);
  }, [initialRuntime]);

  const hubMcpUrl = useMemo(() => `${window.location.origin}/api/mcp`, []);

  const clientConfigSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'ci-hub': {
              url: hubMcpUrl,
              headers: { Authorization: 'Bearer <your-api-key>' },
            },
          },
        },
        null,
        2,
      ),
    [hubMcpUrl],
  );

  const probeMcp = useCallback(async () => {
    if (!app) return;
    setProbing(true);
    try {
      const res = await apiFetch(`/api/apps/${encodeURIComponent(info.urn)}/mcp/probe`, { method: 'POST' });
      if (!res.ok) throw new Error('probe failed');
      setRuntime((await res.json()) as McpRuntime);
    } catch {
      toast.error(t('APP_MCP_PROBE_ERROR', { defaultValue: 'MCP bridge probe failed' }));
    } finally {
      setProbing(false);
    }
  }, [app, info.urn, t]);

  if (!mcp) {
    return null;
  }

  const tools = mcp.manifest?.tools ?? [];
  const installed = Boolean(app);
  const badge = bridgeStatusBadge(runtime, installed, t);

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('SETTINGS_NETWORK_COPIED'));
    } catch {
      toast.error(t('SETTINGS_GENERAL_COPY_FAILED'));
    }
  };

  return (
    <Card className="border-border/60 bg-card/80 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Plug className="h-4 w-4 text-violet-500" />
          {t('APP_MCP_CARD_TITLE')}
        </CardTitle>
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              badge.tone === 'ok' && 'border-success/40 bg-success/10 text-success',
              badge.tone === 'warn' && 'border-warning/40 bg-warning/10 text-warning',
              badge.tone === 'muted' && 'border-border/70 bg-muted/30 text-muted-foreground',
            )}
          >
            {badge.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Terminal className="h-3 w-3" />
            {mcp.transport}
          </span>
          {installed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={probeMcp}
              disabled={probing}
              aria-label={t('APP_MCP_PROBE', { defaultValue: 'Probe bridge' })}
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', probing && 'animate-spin')} />
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('APP_MCP_CARD_SUBTITLE')}</p>

        {runtime?.lastError && installed ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">{runtime.lastError}</p>
        ) : null}

        {tools.length > 0 && (
          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
              {t('APP_MCP_TOOLS_TITLE', { count: runtime?.connected ? runtime.toolCount : tools.length })}
            </h3>
            <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3">
              {tools.map((tool) => (
                <li key={tool.name} className="text-sm">
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{tool.name}</code>
                  {tool.description ? <span className="ml-2 text-muted-foreground">{tool.description}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {installed && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('APP_MCP_CONNECT_TITLE')}</h3>
            <p className="text-sm text-muted-foreground">{t('APP_MCP_CONNECT_DESCRIPTION')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-border/60 bg-muted/20 px-3 py-2 font-mono text-xs">{hubMcpUrl}</code>
              <Button variant="outline" size="sm" onClick={() => copyToClipboard(hubMcpUrl)} aria-label={t('APP_MCP_COPY_ENDPOINT')}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs leading-5">
                {clientConfigSnippet}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="absolute right-2 top-2"
                onClick={() => copyToClipboard(clientConfigSnippet)}
                aria-label={t('APP_MCP_COPY_CONFIG')}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('APP_MCP_CONNECT_KEY_HINT')}{' '}
              <Link to="/settings?tab=security" className="text-primary underline-offset-2 hover:underline">
                {t('APP_MCP_CONNECT_KEY_LINK')}
              </Link>
            </p>
          </div>
        )}

        {mcp.requires?.notes ? <p className="text-xs italic text-muted-foreground">{mcp.requires.notes}</p> : null}
      </CardContent>
    </Card>
  );
}
