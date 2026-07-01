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
  apiKeyConfigured: boolean;
  endpoint: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
}

type ToolCallResponse = { ok: true; result: unknown } | { ok: false; error: string };

export const McpSettingsContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [search, setSearch] = useState('');

  // Destructive-gate toggle + API-key rotation state.
  const [savingDestructive, setSavingDestructive] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

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
      const [statusRes, toolsRes] = await Promise.all([apiFetch('/api/mcp-admin/status'), apiFetch('/api/mcp-admin/tools')]);
      if (!statusRes.ok || !toolsRes.ok) {
        throw new Error('status');
      }
      setStatus((await statusRes.json()) as McpStatus);
      setTools(((await toolsRes.json()) as { tools: McpToolInfo[] }).tools);
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

  const rotateKey = useCallback(async () => {
    setRotating(true);
    try {
      const res = await apiFetch('/api/mcp-admin/key/rotate', { method: 'POST' });
      if (!res.ok) throw new Error('rotate');
      const body = (await res.json()) as { apiKey: string };
      setRotatedKey(body.apiKey);
      setStatus((prev) => (prev ? { ...prev, apiKeyConfigured: true } : prev));
      toast.success(t('MCP_SETTINGS_KEY_ROTATED'));
    } catch {
      toast.error(t('MCP_SETTINGS_LOAD_ERROR'));
    } finally {
      setRotating(false);
      setRotateConfirmOpen(false);
    }
  }, [t]);

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
            value={status.endpoint}
            onClick={() => copyToClipboard(status.endpoint, t('MCP_SETTINGS_ENDPOINT_COPIED'))}
          />
        </CardContent>
      </Card>

      {/* API key */}
      <Card>
        <CardHeader>
          <CardTitle>{t('MCP_SETTINGS_KEY_TITLE')}</CardTitle>
          <CardDescription>{status.apiKeyConfigured ? t('MCP_SETTINGS_KEY_CONFIGURED') : t('MCP_SETTINGS_KEY_MISSING')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => setRotateConfirmOpen(true)} data-testid="mcp-rotate-key">
            {t('MCP_SETTINGS_KEY_ROTATE')}
          </Button>
          {rotatedKey && (
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{rotatedKey}</code>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(rotatedKey, t('MCP_SETTINGS_KEY_COPIED'))}>
                {t('MCP_SETTINGS_KEY_COPY')}
              </Button>
            </div>
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
            <ul className="divide-y divide-border">
              {filteredTools.map((tool) => (
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
          )}
        </CardContent>
      </Card>

      {/* Rotate-key confirmation */}
      <Dialog open={rotateConfirmOpen} onOpenChange={setRotateConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('MCP_SETTINGS_KEY_ROTATE_CONFIRM_TITLE')}</DialogTitle>
            <DialogDescription>{t('MCP_SETTINGS_KEY_ROTATE_CONFIRM_DESC')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateConfirmOpen(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button variant="destructive" loading={rotating} onClick={() => void rotateKey()}>
              {t('MCP_SETTINGS_KEY_ROTATE')}
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
          <div className="space-y-2">
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
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs" data-testid="mcp-run-result">
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

/** A single labelled status value; clickable when an onClick is supplied (e.g. copy the endpoint). */
const StatItem = ({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) => (
  <div className="space-y-0.5">
    <p className="text-xs text-muted-foreground">{label}</p>
    {onClick ? (
      <button type="button" className="truncate text-left font-medium text-primary hover:underline" onClick={onClick}>
        {value}
      </button>
    ) : (
      <p className="truncate font-medium">{value}</p>
    )}
  </div>
);
