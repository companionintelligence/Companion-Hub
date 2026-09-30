import { apiFetch } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { extractAppUrn } from '@/utils/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';

// ENH-MCP-4: operator screen for the Hub's MCP server. Talks to the session-authed /api/mcp-admin
// surface (never the Bearer /api/mcp endpoint), so the browser never holds the agent key and the
// tool runner executes server-side. Mirrors the existing settings-container pattern (ai-settings).
// API-key management moved to the hub-wide Settings → Security card (ApiKeysContainer); this tab
// only links there.
//
// The appliance-wide "Destructive tools" switch that used to live here is gone: destructive access is
// now each key's `capability`, granted one key at a time in Settings → Security. A single switch could
// only be on or off for every key at once, so enabling it for one agent enabled it for all of them.

interface McpStatus {
  enabled: boolean;
  server: { name: string; version: string };
  protocolVersion: string;
  protocolVersions?: string[];
  toolCount: number;
  activeSessions: number;
  activeKeyCount: number;
  endpoint: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  /** Which capability level reaches this tool — 'read' tools are callable by every key, 'write' ones
   *  only by a 'write' or 'full' key (and destructive ones only by 'full'). */
  access: 'read' | 'write';
  category?: string;
}

interface McpInstalledApp {
  urn: string;
  name: string;
  status: string;
  bridge?: {
    connected: boolean;
    toolCount: number;
    containerStatus: string;
    lastError?: string;
  };
}

interface InstalledAppsResponse {
  installed: Array<{ app: { status: string }; info: { urn: string; name: string; mcp?: unknown } }>;
}

type ToolCallResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** `/apps/:storeId/:appId` for an installed app's `appName:appStoreId` URN. */
const installedAppPath = (urn: string) => {
  const { appName, appStoreId } = extractAppUrn(urn as AppUrn);
  return `/apps/${appStoreId}/${appName}`;
};

export const McpSettingsContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [search, setSearch] = useState('');

  // Tool runner state.
  const [runTool, setRunTool] = useState<McpToolInfo | null>(null);
  const [runArgs, setRunArgs] = useState('{}');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  // Explicit operator confirmation for running a destructive tool (never auto-confirmed).
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [installedMcpApps, setInstalledMcpApps] = useState<McpInstalledApp[]>([]);

  const loadInstalledMcpApps = useCallback(async () => {
    try {
      const res = await apiFetch('/api/apps/installed');
      if (!res.ok) return;
      const body = (await res.json()) as InstalledAppsResponse;
      const mcpApps = body.installed.filter((entry) => entry.info.mcp);
      const withStatus = await Promise.all(
        mcpApps.map(async (entry) => {
          let bridge: McpInstalledApp['bridge'];
          try {
            const statusRes = await apiFetch(`/api/apps/${encodeURIComponent(entry.info.urn)}/mcp/status`);
            if (statusRes.ok) {
              const status = (await statusRes.json()) as McpInstalledApp['bridge'] & {
                connected: boolean;
                toolCount: number;
                containerStatus: string;
                lastError?: string;
              };
              bridge = {
                connected: status.connected,
                toolCount: status.toolCount,
                containerStatus: status.containerStatus,
                lastError: status.lastError,
              };
            }
          } catch {
            /* best effort */
          }
          return {
            urn: entry.info.urn,
            name: entry.info.name,
            status: entry.app.status,
            bridge,
          };
        }),
      );
      setInstalledMcpApps(withStatus);
    } catch {
      /* optional section */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, toolsRes] = await Promise.all([apiFetch('/api/mcp-admin/status'), apiFetch('/api/mcp-admin/tools')]);
      if (!statusRes.ok || !toolsRes.ok) {
        throw new Error('status');
      }
      setStatus((await statusRes.json()) as McpStatus);
      setTools(((await toolsRes.json()) as { tools: McpToolInfo[] }).tools);
      await loadInstalledMcpApps();
    } catch {
      setError(t('MCP_SETTINGS_LOAD_ERROR'));
    } finally {
      setLoading(false);
    }
  }, [t, loadInstalledMcpApps]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q));
  }, [tools, search]);

  // Group the (filtered) catalog by the backend-provided category for clarity. Categories sort
  // alphabetically; 'Other' (untagged/bridged tools) is pinned last.
  const toolGroups = useMemo(() => {
    const groups = new Map<string, McpToolInfo[]>();
    for (const tool of filteredTools) {
      const category = tool.category ?? 'Other';
      const existing = groups.get(category);
      if (existing) existing.push(tool);
      else groups.set(category, [tool]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    });
  }, [filteredTools]);

  const openRunner = useCallback((tool: McpToolInfo) => {
    setRunTool(tool);
    setRunArgs('{}');
    setRunResult(null);
    setRunConfirmed(false);
  }, []);

  const runToolCall = useCallback(async () => {
    if (!runTool) return;
    let parsedArgs: Record<string, unknown>;
    try {
      // JSON.parse happily yields arrays/null/primitives; the backend McpToolCallBody DTO requires
      // an object record, so guard here to surface a clear message instead of a confusing 400.
      const parsed: unknown = runArgs.trim() ? JSON.parse(runArgs) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        toast.error(t('MCP_SETTINGS_RUN_ARGS_NOT_OBJECT'));
        return;
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch {
      toast.error(t('MCP_SETTINGS_RUN_INVALID_JSON'));
      return;
    }
    setRunning(true);
    setRunResult(null);
    try {
      const res = await apiFetch(`/api/mcp-admin/tools/${encodeURIComponent(runTool.name)}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only forward the destructive confirmation when the operator has explicitly ticked it.
        body: JSON.stringify({ arguments: parsedArgs, confirmDestructive: Boolean(runTool.destructive && runConfirmed) }),
      });
      const body = (await res.json()) as ToolCallResponse;
      if (body.ok) {
        setRunResult(JSON.stringify(body.result, null, 2));
        toast.success(t('MCP_SETTINGS_RUN_SUCCESS'));
      } else {
        setRunResult(body.error);
        toast.error(t('MCP_SETTINGS_RUN_ERROR', { message: body.error }));
      }
    } catch {
      toast.error(t('MCP_SETTINGS_LOAD_ERROR'));
    } finally {
      setRunning(false);
    }
  }, [runTool, runArgs, runConfirmed, t]);

  if (loading) {
    return (
      <div className="space-y-4" data-testid="mcp-settings-loading">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error ?? t('MCP_SETTINGS_LOAD_ERROR')}</p>
        <Button variant="outline" onClick={() => void load()}>
          {t('COMMON_RETRY')}
        </Button>
      </div>
    );
  }

  // The backend reports the endpoint as a path (/api/mcp); show + copy the absolute URL an agent
  // would actually connect to, resolved against the origin the operator is browsing the Hub on.
  const endpointUrl = /^https?:\/\//.test(status.endpoint) ? status.endpoint : `${window.location.origin}${status.endpoint}`;

  return (
    <div className="space-y-6" data-testid="mcp-settings">
      <div>
        <h3 className="text-lg font-medium">{t('MCP_SETTINGS_TITLE')}</h3>
        <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_DESC')}</p>
      </div>

      {/* Server status */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_STATUS_TITLE')}</CardTitle>
          <CardDescription>{status.enabled ? t('MCP_SETTINGS_STATUS_ENABLED_HINT') : t('MCP_SETTINGS_STATUS_DISABLED_HINT')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <StatItem
            label={t('MCP_SETTINGS_STATUS_TITLE')}
            value={status.enabled ? t('MCP_SETTINGS_STATUS_ENABLED') : t('MCP_SETTINGS_STATUS_DISABLED')}
          />
          <StatItem label={t('MCP_SETTINGS_SERVER')} value={`${status.server.name} ${status.server.version}`} />
          <StatItem label={t('MCP_SETTINGS_PROTOCOL')} value={(status.protocolVersions ?? [status.protocolVersion]).join(', ')} />
          <StatItem label={t('MCP_SETTINGS_TOOL_COUNT')} value={String(status.toolCount)} />
          <StatItem label={t('MCP_SETTINGS_ACTIVE_SESSIONS')} value={String(status.activeSessions)} />
          <StatItem
            label={t('MCP_SETTINGS_ENDPOINT')}
            value={endpointUrl}
            onClick={() => copyToClipboard(endpointUrl, t('MCP_SETTINGS_ENDPOINT_COPIED'))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_INSTALLED_TITLE')}</CardTitle>
          <CardDescription>{t('MCP_SETTINGS_INSTALLED_DESC')}</CardDescription>
        </CardHeader>
        <CardContent>
          {installedMcpApps.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_INSTALLED_EMPTY')}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">App</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Bridge</th>
                    <th className="pb-2 font-medium">Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {installedMcpApps.map((entry) => (
                    <tr key={entry.urn} className="border-b border-border/40 last:border-0">
                      <td className="py-2 pr-4">
                        {/*
                          An app URN is `appName:appStoreId`, and the route is
                          `/apps/:storeId/:appId` — so the segments have to be swapped, not
                          just joined. This was `/app-store/${urn.replace(':', '/')}`, which
                          is wrong twice over: there is no `/app-store` route (the store lives
                          at `/store`) and the order was reversed, so every row here landed on
                          the 404 page.
                        */}
                        <Link to={installedAppPath(entry.urn)} className="text-primary underline-offset-2 hover:underline">
                          {entry.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 capitalize">{entry.status}</td>
                      <td className="py-2 pr-4">
                        {entry.bridge?.connected ? 'Connected' : entry.bridge?.lastError ? 'Needs attention' : (entry.bridge?.containerStatus ?? '—')}
                      </td>
                      <td className="py-2">{entry.bridge?.toolCount ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API keys moved to the hub-wide Settings → Security card. Point operators there and keep
          the tab's key-count visibility via the status endpoint's activeKeyCount. */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_KEYS_TITLE')}</CardTitle>
          <CardDescription>{t('API_KEYS_DESC')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground" data-testid="mcp-active-key-count">
              {t('MCP_SETTINGS_ACTIVE_KEYS', { count: status.activeKeyCount })}
            </p>
            {/* Where the destructive gate went, said explicitly — an operator who remembers the
                switch on this tab needs to be told where the decision moved to, not just find it
                missing. */}
            <p className="text-xs text-muted-foreground">{t('MCP_SETTINGS_CAPABILITY_HINT')}</p>
          </div>
          <Button asChild variant="outline" data-testid="mcp-manage-keys">
            <Link to="/settings?tab=security">{t('MCP_SETTINGS_MANAGE_KEYS_LINK')}</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Tool catalog */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_TOOLS_TITLE')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder={t('MCP_SETTINGS_TOOLS_SEARCH')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="mcp-tool-search"
          />
          {filteredTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_TOOLS_EMPTY')}</p>
          ) : (
            <div className="space-y-4" data-testid="mcp-tool-groups">
              {toolGroups.map(([category, groupTools]) => (
                <div key={category} className="space-y-1">
                  <div className="flex items-center gap-2" data-testid={`mcp-tool-category-${category}`}>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{category}</h4>
                    <span className="text-xs text-muted-foreground">({groupTools.length})</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {groupTools.map((tool) => (
                      <li key={tool.name} className="flex items-start justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <code className="text-sm font-medium">{tool.name}</code>
                            {/* A tool is badged by the least capability that reaches it: 'destructive'
                                implies write, so the two badges are alternatives, not a stack. */}
                            {tool.destructive ? (
                              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                                {t('MCP_SETTINGS_TOOL_DESTRUCTIVE_BADGE')}
                              </span>
                            ) : (
                              tool.access === 'write' && (
                                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{t('MCP_SETTINGS_TOOL_WRITE_BADGE')}</span>
                              )
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{tool.description}</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => openRunner(tool)}>
                          {t('MCP_SETTINGS_RUN')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tool runner */}
      <Dialog open={Boolean(runTool)} onOpenChange={(open) => !open && setRunTool(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('MCP_SETTINGS_RUN_TITLE', { tool: runTool?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          {/* min-w-0: this is a grid item of DialogContent; without it the result <pre>'s long lines
              force the grid track wide and blow the dialog past its max-width instead of scrolling. */}
          <div className="min-w-0 space-y-2">
            <label className="text-sm font-medium" htmlFor="mcp-run-args">
              {t('MCP_SETTINGS_RUN_ARGS_LABEL')}
            </label>
            <textarea
              id="mcp-run-args"
              className="h-28 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
              value={runArgs}
              onChange={(e) => setRunArgs(e.target.value)}
              data-testid="mcp-run-args"
            />
            {runTool?.destructive && (
              <Checkbox
                name="mcp-run-confirm"
                checked={runConfirmed}
                onCheckedChange={(v: boolean) => setRunConfirmed(v)}
                label={t('MCP_SETTINGS_RUN_DESTRUCTIVE_CONFIRM')}
                className="text-destructive"
              />
            )}
            {runResult !== null && (
              <div>
                <p className="text-sm font-medium">{t('MCP_SETTINGS_RUN_RESULT')}</p>
                <pre className="max-h-48 w-full min-w-0 overflow-auto rounded-md bg-muted p-2 text-xs" data-testid="mcp-run-result">
                  {runResult}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunTool(null)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              variant={runTool?.destructive ? 'destructive' : 'default'}
              loading={running}
              // Destructive tools require an explicit confirmation tick before Run is enabled.
              disabled={running || Boolean(runTool?.destructive && !runConfirmed)}
              onClick={() => void runToolCall()}
              data-testid="mcp-run-submit"
            >
              {t('MCP_SETTINGS_RUN')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** A single labelled status value; clickable when an onClick is supplied (e.g. copy the endpoint).
 *  The clickable variant carries cursor-pointer (browsers/Tailwind Preflight leave <button> as the
 *  default arrow) and a title tooltip so the full value is legible even when the column truncates it. */
const StatItem = ({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) => (
  <div className="space-y-0.5">
    <p className="text-xs text-muted-foreground">{label}</p>
    {onClick ? (
      <button
        type="button"
        title={value}
        className="w-full cursor-pointer truncate text-left font-medium text-primary hover:underline"
        onClick={onClick}
      >
        {value}
      </button>
    ) : (
      <p className="truncate font-medium">{value}</p>
    )}
  </div>
);
