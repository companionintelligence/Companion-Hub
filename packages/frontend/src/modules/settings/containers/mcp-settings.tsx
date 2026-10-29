import { apiFetch } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { Blocks, ChevronRight, Copy, KeyRound, Search, Server, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { Detail, DetailGrid, LoadingCard, SectionHeader, StatusBadge, StatusDot } from '../components/network-section/network-section';

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

/** The catalog's access filter, by the least key capability that reaches a tool (see `McpToolInfo.access`). */
type ToolAccessFilter = 'all' | 'read' | 'write' | 'destructive';
const TOOL_ACCESS_FILTERS: ToolAccessFilter[] = ['all', 'read', 'write', 'destructive'];
const TOOL_ACCESS_FILTER_LABEL: Record<ToolAccessFilter, string> = {
  all: 'MCP_SETTINGS_TOOLS_FILTER_ALL',
  read: 'MCP_SETTINGS_TOOLS_FILTER_READ',
  write: 'MCP_SETTINGS_TOOLS_FILTER_WRITE',
  destructive: 'MCP_SETTINGS_TOOLS_FILTER_DESTRUCTIVE',
};

function toolAccessLevel(tool: { access: 'read' | 'write'; destructive: boolean }): Exclude<ToolAccessFilter, 'all'> {
  if (tool.destructive) return 'destructive';
  return tool.access === 'write' ? 'write' : 'read';
}

/** Above this many tools the catalog opens with its groups closed: 76 tools open was about 4,000px of page. */
const TOOL_CATALOG_OPEN_MAX = 12;

/** Top-level field names from a tool's JSON schema. Not a form: the textarea stays the way arguments are sent. */
export function mcpToolFields(schema: Record<string, unknown>): { name: string; required: boolean }[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : []);
  return Object.keys(properties).map((name) => ({ name, required: required.has(name) }));
}

/** App URNs are `appId:storeId`. The app page is `/store/:storeId/:appId`. */
export function mcpAppStorePath(urn: string): string | null {
  const [appId, storeId] = urn.split(':');
  if (!appId || !storeId) return null;
  return `/store/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`;
}

export const McpSettingsContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [search, setSearch] = useState('');
  const [accessFilter, setAccessFilter] = useState<ToolAccessFilter>('all');
  // Groups the operator opened by hand while the catalog is collapsed.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  // Tool runner state.
  const [runTool, setRunTool] = useState<McpToolInfo | null>(null);
  const [runArgs, setRunArgs] = useState('{}');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  // Explicit operator confirmation for running a destructive tool (never auto-confirmed).
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [installedMcpApps, setInstalledMcpApps] = useState<McpInstalledApp[]>([]);
  const [installedError, setInstalledError] = useState(false);

  const loadInstalledMcpApps = useCallback(async () => {
    try {
      const res = await apiFetch('/api/apps/installed');
      if (!res.ok) {
        setInstalledError(true);
        return;
      }
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
      setInstalledError(false);
      setInstalledMcpApps(withStatus);
    } catch {
      setInstalledError(true);
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
    return tools.filter(
      (tool) =>
        (accessFilter === 'all' || toolAccessLevel(tool) === accessFilter) &&
        (!q || tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q)),
    );
  }, [tools, search, accessFilter]);

  const accessCounts = useMemo(() => {
    const counts: Record<ToolAccessFilter, number> = { all: tools.length, read: 0, write: 0, destructive: 0 };
    for (const tool of tools) counts[toolAccessLevel(tool)] += 1;
    return counts;
  }, [tools]);

  // A search or an access filter shows every match open; otherwise a long catalog starts closed.
  const narrowed = search.trim() !== '' || accessFilter !== 'all';
  const collapseGroups = tools.length > TOOL_CATALOG_OPEN_MAX;

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
      <div className="space-y-6" data-testid="mcp-settings-loading">
        <LoadingCard icon={Server} title={t('MCP_SETTINGS_SERVER_TITLE')} />
        <LoadingCard icon={Wrench} title={t('MCP_SETTINGS_TOOLS_TITLE')} />
      </div>
    );
  }

  if (error || !status) {
    return (
      <Card>
        <SectionHeader icon={Server} title={t('MCP_SETTINGS_SERVER_TITLE')} />
        <CardContent className="space-y-3">
          <p className="text-sm text-destructive">{error ?? t('MCP_SETTINGS_LOAD_ERROR')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            {t('COMMON_RETRY')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // The backend reports the endpoint as a path (/api/mcp); show + copy the absolute URL an agent
  // would actually connect to, resolved against the origin the operator is browsing the Hub on.
  const endpointUrl = /^https?:\/\//.test(status.endpoint) ? status.endpoint : `${window.location.origin}${status.endpoint}`;

  return (
    <div className="space-y-6" data-testid="mcp-settings">
      {/* Server. The tab's own heading used to sit above this card, which no other Settings tab
          has; its description is this card's description now. */}
      <Card data-testid="mcp-server-card">
        <SectionHeader
          icon={Server}
          title={t('MCP_SETTINGS_SERVER_TITLE')}
          description={t('MCP_SETTINGS_DESC')}
          badge={
            <StatusBadge connected={status.enabled} label={status.enabled ? t('MCP_SETTINGS_STATUS_ENABLED') : t('MCP_SETTINGS_STATUS_DISABLED')} />
          }
        />
        <CardContent className="space-y-4">
          <DetailGrid>
            <Detail label={t('MCP_SETTINGS_SERVER')} value={`${status.server.name} ${status.server.version}`} />
            <Detail label={t('MCP_SETTINGS_PROTOCOL')} value={(status.protocolVersions ?? [status.protocolVersion]).join(', ')} />
            <Detail label={t('MCP_SETTINGS_TOOL_COUNT')} value={String(status.toolCount)} />
            <Detail label={t('MCP_SETTINGS_ACTIVE_SESSIONS')} value={String(status.activeSessions)} />
          </DetailGrid>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">{t('MCP_SETTINGS_ENDPOINT')}</p>
            {/* The URL is the button's own text, so it is what a click copies and what a screen reader reads. */}
            <button
              type="button"
              title={endpointUrl}
              className="group inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-1.5 text-left font-mono text-[13px] hover:border-primary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => copyToClipboard(endpointUrl, t('MCP_SETTINGS_ENDPOINT_COPIED'))}
              data-testid="mcp-endpoint-copy"
            >
              <span className="sr-only">{t('MCP_SETTINGS_ENDPOINT_COPY')}</span>
              {endpointUrl}
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {status.enabled ? t('MCP_SETTINGS_STATUS_ENABLED_HINT') : t('MCP_SETTINGS_STATUS_DISABLED_HINT')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={Blocks} title={t('MCP_SETTINGS_INSTALLED_TITLE')} description={t('MCP_SETTINGS_INSTALLED_DESC')} />
        <CardContent>
          {installedError ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive" data-testid="mcp-installed-error">
                {t('MCP_SETTINGS_INSTALLED_ERROR')}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadInstalledMcpApps()}>
                {t('COMMON_RETRY')}
              </Button>
            </div>
          ) : installedMcpApps.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_INSTALLED_EMPTY')}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('MCP_SETTINGS_INSTALLED_COL_APP')}</th>
                    <th className="py-2 pr-3 font-medium">{t('MCP_SETTINGS_INSTALLED_COL_STATUS')}</th>
                    <th className="py-2 pr-3 font-medium">{t('MCP_SETTINGS_INSTALLED_COL_BRIDGE')}</th>
                    <th className="py-2 text-right font-medium">{t('MCP_SETTINGS_INSTALLED_COL_TOOLS')}</th>
                  </tr>
                </thead>
                <tbody>
                  {installedMcpApps.map((entry) => {
                    const appPath = mcpAppStorePath(entry.urn);
                    return (
                      <tr key={entry.urn} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          {appPath ? (
                            <Link to={appPath} className="text-primary underline-offset-2 hover:underline">
                              {entry.name}
                            </Link>
                          ) : (
                            entry.name
                          )}
                        </td>
                        <td className="py-2 pr-3 capitalize">{entry.status}</td>
                        <td className="py-2 pr-3">
                          {entry.bridge?.connected ? (
                            <span className="inline-flex items-center gap-1.5">
                              <StatusDot tone="ok" />
                              {t('MCP_SETTINGS_BRIDGE_CONNECTED')}
                            </span>
                          ) : entry.bridge?.lastError ? (
                            <span className="inline-flex items-center gap-1.5 text-warning" title={entry.bridge.lastError}>
                              <StatusDot tone="warn" />
                              {t('MCP_SETTINGS_BRIDGE_NEEDS_ATTENTION')}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{entry.bridge?.containerStatus ?? '—'}</span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{entry.bridge?.toolCount ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API keys moved to the hub-wide Settings → Security card. Point operators there and keep
          the tab's key-count visibility via the status endpoint's activeKeyCount. */}
      <Card>
        <SectionHeader icon={KeyRound} title={t('MCP_SETTINGS_KEYS_TITLE')} description={t('API_KEYS_DESC')} />
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {/* Counts keys with the `mcp` scope only, so the Portal's push key (also listed under
                Security) is not in it. The label says which keys it counts. */}
            <p className="text-sm" data-testid="mcp-active-key-count">
              {t('MCP_SETTINGS_ACTIVE_KEYS', { count: status.activeKeyCount })}
            </p>
            {/* Where the destructive gate went, said explicitly — an operator who remembers the
                switch on this tab needs to be told where the decision moved to, not just find it
                missing. */}
            <p className="text-xs text-muted-foreground">{t('MCP_SETTINGS_CAPABILITY_HINT')}</p>
          </div>
          <Button asChild size="sm" variant="outline" data-testid="mcp-manage-keys">
            <Link to="/settings?tab=security">{t('MCP_SETTINGS_MANAGE_KEYS_LINK')}</Link>
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="mcp-tool-catalog">
        <SectionHeader icon={Wrench} title={t('MCP_SETTINGS_TOOLS_TITLE')} description={t('MCP_SETTINGS_TOOLS_DESC')} />
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="[&_input]:pl-9"
                aria-label={t('MCP_SETTINGS_TOOLS_SEARCH')}
                placeholder={t('MCP_SETTINGS_TOOLS_SEARCH')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="mcp-tool-search"
              />
            </div>
            {/* Which tools a key of each access level reaches: the question an operator brings here
                before handing an agent a key. Counts are for the whole catalog, not the search. */}
            <fieldset className="flex shrink-0 flex-wrap rounded-md border border-border/50 bg-card/50 p-1" data-testid="mcp-tool-access-filter">
              <legend className="sr-only">{t('MCP_SETTINGS_TOOLS_FILTER_LABEL')}</legend>
              {TOOL_ACCESS_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={accessFilter === filter}
                  data-testid={`mcp-tool-filter-${filter}`}
                  onClick={() => setAccessFilter(filter)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    // The Settings tab strip's own active look, so the two read as the same kind of control.
                    accessFilter === filter && 'bg-background text-foreground shadow-sm',
                  )}
                >
                  {t(TOOL_ACCESS_FILTER_LABEL[filter])}
                  <span className="tabular-nums text-muted-foreground">{accessCounts[filter]}</span>
                </button>
              ))}
            </fieldset>
          </div>

          {filteredTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_TOOLS_EMPTY')}</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border" data-testid="mcp-tool-groups">
              {toolGroups.map(([category, groupTools]) => {
                const destructiveCount = groupTools.filter((tool) => tool.destructive).length;
                return (
                  <details
                    key={category}
                    className="group"
                    open={narrowed || !collapseGroups || openGroups.has(category)}
                    onToggle={(event) => {
                      // A search or filter opens every group; a toggle then is the browser echoing that, not a choice.
                      if (narrowed) return;
                      const isOpen = event.currentTarget.open;
                      setOpenGroups((current) => {
                        const next = new Set(current);
                        if (isOpen) next.add(category);
                        else next.delete(category);
                        return next;
                      });
                    }}
                  >
                    <summary
                      className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
                      data-testid={`mcp-tool-category-${category}`}
                    >
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                      <h4 className="text-sm font-semibold">{category}</h4>
                      <span className="text-xs tabular-nums text-muted-foreground">{groupTools.length}</span>
                      {/* Said on the closed row, because it is the reason to open it. */}
                      {destructiveCount > 0 ? (
                        <span className="ml-auto text-xs text-destructive">
                          {t('MCP_SETTINGS_TOOLS_GROUP_DESTRUCTIVE', { count: destructiveCount })}
                        </span>
                      ) : null}
                    </summary>
                    <ul className="divide-y divide-border/60 border-t border-border">
                      {groupTools.map((tool) => (
                        <li key={tool.name} className="flex items-start justify-between gap-3 py-2.5 pl-9 pr-3">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="break-all text-[13px] font-medium">{tool.name}</code>
                              {/* A tool is badged by the least capability that reaches it: 'destructive'
                                  implies write, so the two badges are alternatives, not a stack. */}
                              {tool.destructive ? (
                                <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 text-[11px] leading-5 text-destructive">
                                  {t('MCP_SETTINGS_TOOL_DESTRUCTIVE_BADGE')}
                                </span>
                              ) : (
                                tool.access === 'write' && (
                                  <span className="rounded-full border border-primary/40 bg-primary/10 px-2 text-[11px] leading-5 text-primary">
                                    {t('MCP_SETTINGS_TOOL_WRITE_BADGE')}
                                  </span>
                                )
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{tool.description}</p>
                          </div>
                          <Button variant="outline" size="sm" className="shrink-0" onClick={() => openRunner(tool)}>
                            {t('MCP_SETTINGS_RUN')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
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
            {runTool && mcpToolFields(runTool.inputSchema).length > 0 ? (
              <ul className="space-y-1 text-sm" data-testid="mcp-run-fields">
                {mcpToolFields(runTool.inputSchema).map((field) => (
                  <li key={field.name}>
                    <code className="font-medium">{field.name}</code>
                    <span className="text-muted-foreground">
                      {' '}
                      {field.required ? t('MCP_SETTINGS_FIELD_REQUIRED') : t('MCP_SETTINGS_FIELD_OPTIONAL')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
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
                onCheckedChange={(checked) => setRunConfirmed(checked === true)}
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
