import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

// ENH-MCP-4: operator screen for the Hub's MCP server. Talks to the session-authed /api/mcp-admin
// surface (never the Bearer /api/mcp endpoint), so the browser never holds the agent key and the
// tool runner executes server-side. Mirrors the existing settings-container pattern (ai-settings).

interface McpStatus {
  enabled: boolean;
  server: { name: string; version: string };
  protocolVersion: string;
  toolCount: number;
  activeSessions: number;
  destructiveAllowed: boolean;
  activeKeyCount: number;
  endpoint: string;
}

interface McpApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  category?: string;
}

type ToolCallResponse = { ok: true; result: unknown } | { ok: false; error: string };

export const McpSettingsContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [search, setSearch] = useState('');

  // Destructive-gate toggle state.
  const [savingDestructive, setSavingDestructive] = useState(false);

  // API-key management state (SEC-MCP-8: multi-key store).
  const [keys, setKeys] = useState<McpApiKeyInfo[]>([]);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  // The raw key is returned only once, at creation — held here so the operator can copy it before it's gone.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  // Tool runner state.
  const [runTool, setRunTool] = useState<McpToolInfo | null>(null);
  const [runArgs, setRunArgs] = useState('{}');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  // Explicit operator confirmation for running a destructive tool (never auto-confirmed).
  const [runConfirmed, setRunConfirmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, toolsRes, keysRes] = await Promise.all([
        apiFetch('/api/mcp-admin/status'),
        apiFetch('/api/mcp-admin/tools'),
        apiFetch('/api/mcp-admin/keys'),
      ]);
      if (!statusRes.ok || !toolsRes.ok || !keysRes.ok) {
        throw new Error('status');
      }
      setStatus((await statusRes.json()) as McpStatus);
      setTools(((await toolsRes.json()) as { tools: McpToolInfo[] }).tools);
      setKeys(((await keysRes.json()) as { keys: McpApiKeyInfo[] }).keys);
    } catch {
      setError(t('MCP_SETTINGS_LOAD_ERROR'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  const toggleDestructive = useCallback(
    async (allow: boolean) => {
      setSavingDestructive(true);
      try {
        const res = await apiFetch('/api/mcp-admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDestructive: allow }),
        });
        if (!res.ok) throw new Error('save');
        setStatus((prev) => (prev ? { ...prev, destructiveAllowed: allow } : prev));
        toast.success(t('MCP_SETTINGS_DESTRUCTIVE_SAVED'));
      } catch {
        toast.error(t('MCP_SETTINGS_DESTRUCTIVE_SAVE_ERROR'));
      } finally {
        setSavingDestructive(false);
      }
    },
    [t],
  );

  const refreshKeys = useCallback(async () => {
    const res = await apiFetch('/api/mcp-admin/keys');
    if (!res.ok) return;
    const body = (await res.json()) as { keys: McpApiKeyInfo[] };
    setKeys(body.keys);
    setStatus((prev) => (prev ? { ...prev, activeKeyCount: body.keys.length } : prev));
  }, []);

  const createKey = useCallback(async () => {
    const name = newKeyName.trim();
    if (!name) return;
    setCreatingKey(true);
    try {
      const res = await apiFetch('/api/mcp-admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('create');
      const body = (await res.json()) as { key: string };
      setCreatedKey(body.key); // shown once
      setCreateKeyOpen(false);
      setNewKeyName('');
      toast.success(t('MCP_SETTINGS_KEY_CREATED'));
      // best-effort: the key already exists and its raw value is revealed, so a list-refresh failure
      // must not surface as "create failed" (which would push the operator to create a duplicate).
      await refreshKeys().catch(() => undefined);
    } catch {
      toast.error(t('MCP_SETTINGS_KEY_CREATE_ERROR'));
    } finally {
      setCreatingKey(false);
    }
  }, [newKeyName, refreshKeys, t]);

  const revokeKey = useCallback(
    async (id: number) => {
      try {
        const res = await apiFetch(`/api/mcp-admin/keys/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('revoke');
        await refreshKeys();
        toast.success(t('MCP_SETTINGS_KEY_REVOKED'));
      } catch {
        toast.error(t('MCP_SETTINGS_KEY_REVOKE_ERROR'));
      }
    },
    [refreshKeys, t],
  );

  const openRunner = useCallback((tool: McpToolInfo) => {
    setRunTool(tool);
    setRunArgs('{}');
    setRunResult(null);
    setRunConfirmed(false);
  }, []);

  // Copy to clipboard, toasting ONLY on a successful write — the Clipboard API can be unavailable
  // (insecure context) or blocked, in which case we stay silent rather than falsely claim success.
  const copyToClipboard = useCallback((text: string, successMsg: string) => {
    const clip = navigator.clipboard;
    if (!clip) return;
    clip.writeText(text).then(
      () => toast.success(successMsg),
      () => {
        /* clipboard write blocked — no false-positive toast */
      },
    );
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
          <StatItem label={t('MCP_SETTINGS_PROTOCOL')} value={status.protocolVersion} />
          <StatItem label={t('MCP_SETTINGS_TOOL_COUNT')} value={String(status.toolCount)} />
          <StatItem label={t('MCP_SETTINGS_ACTIVE_SESSIONS')} value={String(status.activeSessions)} />
          <StatItem
            label={t('MCP_SETTINGS_ENDPOINT')}
            value={endpointUrl}
            onClick={() => copyToClipboard(endpointUrl, t('MCP_SETTINGS_ENDPOINT_COPIED'))}
          />
        </CardContent>
      </Card>

      {/* API keys (SEC-MCP-8: multi-key store) */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_KEYS_TITLE')}</CardTitle>
          <CardDescription>{t('MCP_SETTINGS_KEYS_DESC')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => setCreateKeyOpen(true)} data-testid="mcp-create-key">
            {t('MCP_SETTINGS_KEY_CREATE')}
          </Button>

          {/* A freshly created key is shown once, right here — it can never be retrieved again. */}
          {createdKey && (
            <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-2">
              <p className="text-xs font-medium text-primary">{t('MCP_SETTINGS_KEY_CREATED_ONCE')}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs" data-testid="mcp-created-key">
                  {createdKey}
                </code>
                <Button variant="ghost" size="sm" onClick={() => copyToClipboard(createdKey, t('MCP_SETTINGS_KEY_COPIED'))}>
                  {t('MCP_SETTINGS_KEY_COPY')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>
                  {t('MCP_SETTINGS_KEY_DISMISS')}
                </Button>
              </div>
            </div>
          )}

          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('MCP_SETTINGS_KEYS_EMPTY')}</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="mcp-key-list">
              {keys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{key.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{key.prefix}…</code>
                      {key.managed && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary" title={key.ownerAppUrn ?? undefined}>
                          {t('MCP_SETTINGS_KEY_MANAGED_BADGE')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {key.lastUsedAt
                        ? t('MCP_SETTINGS_KEY_LAST_USED', { when: new Date(key.lastUsedAt).toLocaleString() })
                        : t('MCP_SETTINGS_KEY_NEVER_USED')}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void revokeKey(key.id)}>
                    {t('MCP_SETTINGS_KEY_REVOKE')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Destructive tools gate */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_DESTRUCTIVE_TITLE')}</CardTitle>
          <CardDescription>{t('MCP_SETTINGS_DESTRUCTIVE_DESC')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Switch
            name="mcp-allow-destructive"
            label={t('MCP_SETTINGS_DESTRUCTIVE_TOGGLE')}
            checked={status.destructiveAllowed}
            disabled={savingDestructive}
            onCheckedChange={(checked) => void toggleDestructive(checked)}
          />
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
                            {tool.destructive && (
                              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                                {t('MCP_SETTINGS_TOOL_DESTRUCTIVE_BADGE')}
                              </span>
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

      {/* Create-key dialog */}
      <Dialog open={createKeyOpen} onOpenChange={(open) => !open && setCreateKeyOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('MCP_SETTINGS_KEY_CREATE_TITLE')}</DialogTitle>
            <DialogDescription>{t('MCP_SETTINGS_KEY_CREATE_DESC')}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-2">
            <label className="text-sm font-medium" htmlFor="mcp-new-key-name">
              {t('MCP_SETTINGS_KEY_NAME_LABEL')}
            </label>
            <Input
              id="mcp-new-key-name"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder={t('MCP_SETTINGS_KEY_NAME_PLACEHOLDER')}
              data-testid="mcp-new-key-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateKeyOpen(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              loading={creatingKey}
              disabled={creatingKey || !newKeyName.trim()}
              onClick={() => void createKey()}
              data-testid="mcp-create-key-submit"
            >
              {t('MCP_SETTINGS_KEY_CREATE')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
