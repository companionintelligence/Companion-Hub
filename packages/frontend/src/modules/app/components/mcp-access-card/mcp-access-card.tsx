import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { Copy, Plug, Terminal, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Link } from 'react-router';

interface Props {
  app?: AppDetails | null;
  info: AppInfo;
}

/**
 * Access card for MCP server apps (#936). These apps are `no_gui`, so the regular
 * access-points card renders nothing — leaving a user who installed an MCP server
 * with no clue how to use it. This card fills that hole: what the server offers
 * (tool manifest from the marketplace listing), and how to reach it (the Hub MCP
 * endpoint bridges installed app servers; clients authenticate with an mcp-scoped
 * API key).
 */
export function McpAccessCard({ app, info }: Props) {
  const { t } = useTranslation();
  const mcp = info.mcp;

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

  if (!mcp) {
    return null;
  }

  const tools = mcp.manifest?.tools ?? [];
  const installed = Boolean(app && app.status !== 'missing');

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
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Terminal className="h-3 w-3" />
          {mcp.transport}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('APP_MCP_CARD_SUBTITLE')}</p>

        {tools.length > 0 && (
          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
              {t('APP_MCP_TOOLS_TITLE', { count: tools.length })}
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
