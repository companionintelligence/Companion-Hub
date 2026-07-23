import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// Hub-wide API-key management (Settings → Security), extracted from the MCP settings tab.
// One api_key row can now carry multiple scopes ('mcp' = MCP tools access, 'app' = app→Hub
// callback access), so this card lists EVERY key on the Hub — operator-created MCP keys and
// app-managed keys alike — against the session-authed /api/api-keys surface. The browser never
// sees a raw key except once, at creation.

/** Mirrors the backend ApiKeyInfo (GET /api/api-keys). Never carries the raw key. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Known scopes get a labelled badge; unknown ones fall back to the raw scope string. */
const SCOPE_BADGE_KEYS: Record<string, string> = {
  mcp: 'API_KEYS_SCOPE_MCP',
  app: 'API_KEYS_SCOPE_APP',
};

export const ApiKeysContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  // The raw key is returned only once, at creation — held here so the operator can copy it before it's gone.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/api-keys');
      if (!res.ok) throw new Error('load');
      setKeys(((await res.json()) as { keys: ApiKeyInfo[] }).keys);
    } catch {
      setError(t('API_KEYS_LOAD_ERROR'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Never throws: callers toast their own action's outcome, and a failed list refresh must not be
  // misreported as that action failing — the list just stays stale until the next successful load.
  const refreshKeys = useCallback(async () => {
    try {
      const res = await apiFetch('/api/api-keys');
      if (!res.ok) return;
      setKeys(((await res.json()) as { keys: ApiKeyInfo[] }).keys);
    } catch {
      // stale list until the next refresh
    }
  }, []);

  const createKey = useCallback(async () => {
    const name = newKeyName.trim();
    if (!name) return;
    setCreatingKey(true);
    try {
      const res = await apiFetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('create');
      const body = (await res.json()) as { key: string };
      setCreatedKey(body.key); // shown once
      setCreateKeyOpen(false);
      setNewKeyName('');
      toast.success(t('API_KEYS_CREATED'));
      await refreshKeys();
    } catch {
      toast.error(t('API_KEYS_CREATE_ERROR'));
    } finally {
      setCreatingKey(false);
    }
  }, [newKeyName, refreshKeys, t]);

  const revokeKey = useCallback(
    async (id: number) => {
      try {
        const res = await apiFetch(`/api/api-keys/${id}`, { method: 'DELETE' });
        if (res.status === 409) {
          // The backend refuses to revoke the last usable operator key (an empty store would
          // re-seed the same derived Default key at next boot, resurrecting the credential).
          toast.error(t('API_KEYS_REVOKE_LAST'));
          return;
        }
        if (!res.ok) throw new Error('revoke');
        const body = (await res.json()) as { revoked: boolean };
        // revoked:false = the id no longer exists (e.g. revoked from another tab). No success toast
        // for a no-op — the refresh below reconciles the stale list.
        if (body.revoked) toast.success(t('API_KEYS_REVOKED'));
        await refreshKeys();
      } catch {
        toast.error(t('API_KEYS_REVOKE_ERROR'));
      }
    },
    [refreshKeys, t],
  );

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

  return (
    <Card data-testid="api-keys">
      <CardHeader>
        <CardTitle>{t('API_KEYS_TITLE')}</CardTitle>
        <CardDescription>{t('API_KEYS_DESC')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-24 w-full rounded-2xl" data-testid="api-keys-loading" />
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={() => void load()}>
              {t('COMMON_RETRY')}
            </Button>
          </div>
        ) : (
          <>
            {/* Created keys are MCP-scoped operator keys — there is no scope selector. App-scoped
                keys are managed by the Hub itself, on behalf of installed apps. */}
            <Button variant="outline" onClick={() => setCreateKeyOpen(true)} data-testid="api-key-create">
              {t('API_KEYS_CREATE')}
            </Button>

            {/* A freshly created key is shown once, right here — it can never be retrieved again. */}
            {createdKey && (
              <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-2">
                <p className="text-xs font-medium text-primary">{t('API_KEYS_CREATED_ONCE')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs" data-testid="api-key-created">
                    {createdKey}
                  </code>
                  <Button variant="ghost" size="sm" onClick={() => copyToClipboard(createdKey, t('API_KEYS_COPIED'))}>
                    {t('API_KEYS_COPY')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setCreatedKey(null)}>
                    {t('API_KEYS_DISMISS')}
                  </Button>
                </div>
              </div>
            )}

            {keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('API_KEYS_EMPTY')}</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="api-key-list">
                {keys.map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{key.name}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{key.prefix}…</code>
                        {key.scopes.map((scope) => (
                          <span key={scope} className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                            {SCOPE_BADGE_KEYS[scope] ? t(SCOPE_BADGE_KEYS[scope]) : scope}
                          </span>
                        ))}
                        {key.managed && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary" title={key.ownerAppUrn ?? undefined}>
                            {t('API_KEYS_MANAGED_BADGE')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {key.lastUsedAt ? t('API_KEYS_LAST_USED', { when: new Date(key.lastUsedAt).toLocaleString() }) : t('API_KEYS_NEVER_USED')}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void revokeKey(key.id)}>
                      {t('API_KEYS_REVOKE')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {/* Create-key dialog */}
      <Dialog open={createKeyOpen} onOpenChange={(open) => !open && setCreateKeyOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('API_KEYS_CREATE_TITLE')}</DialogTitle>
            <DialogDescription>{t('API_KEYS_CREATE_DESC')}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-2">
            <label className="text-sm font-medium" htmlFor="api-key-new-name">
              {t('API_KEYS_NAME_LABEL')}
            </label>
            <Input
              id="api-key-new-name"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder={t('API_KEYS_NAME_PLACEHOLDER')}
              data-testid="api-key-new-name"
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
              data-testid="api-key-create-submit"
            >
              {t('API_KEYS_CREATE')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
