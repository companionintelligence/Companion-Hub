import { type ApiKeyCapability, CapabilityBadge, isCapabilityPromotion } from '@/components/capability-badge/capability-badge';
import { CapabilityPicker } from '@/components/capability-badge/capability-picker';
import { ScopeBadge } from '@/components/scope-badge/scope-badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// Hub-wide API-key management (Settings → Security), extracted from the MCP settings tab.
// One api_key row can now carry multiple scopes ('mcp' = MCP tools access, 'app' = app→Hub
// callback access), so this card lists EVERY key on the Hub — operator-created MCP keys and
// app-managed keys alike — against the session-authed /api/api-keys surface. The browser never
// sees a raw key except once, at creation.
//
// Each key also carries a `capability` ('read' | 'write' | 'full') saying what it may DO on the MCP
// tool surface. That replaced the appliance-wide "Destructive tools" switch on the MCP tab, which
// could only be on or off for every key at once — so this card is now where destructive access is
// granted, one key at a time.

/** Mirrors the backend ApiKeyInfo (GET /api/api-keys). Never carries the raw key. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  capability: ApiKeyCapability;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** The Hub person who created the key, whose grants and role it acts with; `null` when nobody is recorded. */
  createdByUserId: number | null;
  createdByUsername: string | null;
}

/** The one definition of the list read — the initial load and every post-action refresh share it,
 *  so the endpoint and response envelope live in a single place. Throws on a non-2xx; callers
 *  decide whether that surfaces as an error state or just leaves the list stale. */
const fetchApiKeys = async (): Promise<ApiKeyInfo[]> => {
  const res = await apiFetch('/api/api-keys');
  if (!res.ok) {
    throw new Error('api-keys request failed');
  }
  return ((await res.json()) as { keys: ApiKeyInfo[] }).keys;
};

/** Capability gates the MCP tool surface only, so it is meaningful for a key that can reach it and
 *  inert for one that cannot (an 'app'-only callback key is identity-checked against its owning app
 *  instead). Showing a level on a key it does not govern would read as a security guarantee that
 *  nothing enforces. */
const governsTools = (key: ApiKeyInfo): boolean => key.scopes.includes('mcp');

export const ApiKeysContainer = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyCapability, setNewKeyCapability] = useState<ApiKeyCapability>('write');
  const [creatingKey, setCreatingKey] = useState(false);
  // The raw key is returned only once, at creation — held here so the operator can copy it before it's gone.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  // Capability-change dialog. `changeTarget` is the key being edited; `changeTo` the chosen level.
  // A promotion additionally passes through a confirm step, so the state carries which step we're on
  // rather than nesting a second dialog — one dialog with two faces is easier to reason about, and
  // impossible to leave half-open.
  const [changeTarget, setChangeTarget] = useState<ApiKeyInfo | null>(null);
  const [changeTo, setChangeTo] = useState<ApiKeyCapability>('write');
  const [changeStep, setChangeStep] = useState<'choose' | 'confirm'>('choose');
  const [savingCapability, setSavingCapability] = useState(false);

  // One loader with a `silent` mode. The initial load drives the loading/error UI; a post-action
  // refresh runs silent — a failed refresh must not be misreported as the action itself failing
  // (the caller already toasted its own outcome), so it just leaves the list stale until next time.
  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        setKeys(await fetchApiKeys());
      } catch {
        if (!silent) {
          setError(t('API_KEYS_LOAD_ERROR'));
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refreshKeys = useCallback(() => load({ silent: true }), [load]);

  const openCreate = useCallback(() => {
    setNewKeyName('');
    // Reset to the default every time: a level chosen for the last key must not silently carry over
    // into the next one, least of all 'full'.
    setNewKeyCapability('write');
    setCreateKeyOpen(true);
  }, []);

  const createKey = useCallback(async () => {
    const name = newKeyName.trim();
    if (!name) return;
    setCreatingKey(true);
    try {
      const res = await apiFetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, capability: newKeyCapability }),
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
  }, [newKeyName, newKeyCapability, refreshKeys, t]);

  const openCapabilityChange = useCallback((key: ApiKeyInfo) => {
    setChangeTarget(key);
    setChangeTo(key.capability);
    setChangeStep('choose');
  }, []);

  const closeCapabilityChange = useCallback(() => {
    setChangeTarget(null);
    setChangeStep('choose');
  }, []);

  /** Save the chosen level, routing a promotion through the confirm step first. */
  const submitCapability = useCallback(async () => {
    if (!changeTarget) return;
    // A promotion grants authority the key did not have, so it must be confirmed with the
    // consequence spelled out. A demotion only ever takes authority away — making that harder would
    // just discourage tightening a key, which is the outcome this whole feature exists to encourage.
    if (changeStep === 'choose' && isCapabilityPromotion(changeTarget.capability, changeTo)) {
      setChangeStep('confirm');
      return;
    }
    setSavingCapability(true);
    try {
      const res = await apiFetch(`/api/api-keys/${changeTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: changeTo }),
      });
      if (!res.ok) throw new Error('patch');
      const body = (await res.json()) as { changed: boolean };
      // changed:false means the level was already this one, or the key is gone (revoked in another
      // tab). Neither is an error and neither deserves a success toast — the refresh reconciles it.
      if (body.changed) toast.success(t('API_KEYS_CAPABILITY_SAVED'));
      closeCapabilityChange();
      await refreshKeys();
    } catch {
      toast.error(t('API_KEYS_CAPABILITY_SAVE_ERROR'));
    } finally {
      setSavingCapability(false);
    }
  }, [changeTarget, changeTo, changeStep, closeCapabilityChange, refreshKeys, t]);

  const revokeKey = useCallback(
    async (id: number) => {
      try {
        // Any key can be revoked, including the last one — nothing is seeded at boot, so an
        // appliance with zero keys is a valid end state (the MCP tool surface is just closed).
        const res = await apiFetch(`/api/api-keys/${id}`, { method: 'DELETE' });
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

  // Which confirmation to show is keyed on the level being granted, not on the jump: read → full and
  // write → full both hand over destructive tools, so both get the destructive wording.
  const confirmTitleKey = changeTo === 'full' ? 'API_KEYS_CAPABILITY_CONFIRM_FULL_TITLE' : 'API_KEYS_CAPABILITY_CONFIRM_WRITE_TITLE';
  const confirmBodyKey = changeTo === 'full' ? 'API_KEYS_CAPABILITY_CONFIRM_FULL_BODY' : 'API_KEYS_CAPABILITY_CONFIRM_WRITE_BODY';

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
            {/* Created keys are MCP-scoped operator keys — the scope is fixed, but what the key may
                DO with it is a choice, made in the dialog. App-scoped keys are managed by the Hub
                itself, on behalf of installed apps. */}
            <Button variant="outline" onClick={openCreate} data-testid="api-key-create">
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
                          <ScopeBadge key={scope} scope={scope} />
                        ))}
                        {governsTools(key) && <CapabilityBadge capability={key.capability} />}
                        {key.managed && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary" title={key.ownerAppUrn ?? undefined}>
                            {t('API_KEYS_MANAGED_BADGE')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {key.lastUsedAt ? t('API_KEYS_LAST_USED', { when: new Date(key.lastUsedAt).toLocaleString() }) : t('API_KEYS_NEVER_USED')}
                      </p>
                      {/* An operator key acts as whoever created it; a managed key acts for its app, so it has no creator to name. */}
                      {!key.managed && (
                        <p className="text-xs text-muted-foreground" data-testid={`api-key-creator-${key.id}`}>
                          {key.createdByUsername ? t('API_KEYS_CREATED_BY', { name: key.createdByUsername }) : t('API_KEYS_CREATED_BY_UNKNOWN')}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {governsTools(key) && (
                        <Button variant="ghost" size="sm" onClick={() => openCapabilityChange(key)} data-testid={`api-key-change-${key.id}`}>
                          {t('API_KEYS_CAPABILITY_CHANGE')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void revokeKey(key.id)}>
                        {t('API_KEYS_REVOKE')}
                      </Button>
                    </div>
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
          {/* The scope is fixed, so it's stated rather than chosen: an operator-created 'app' key
              would have no owning app URN and could never pass the callback guard's identity
              check, so offering the choice would only mint dead credentials. Shown with the same
              badge the list rows use, so "MCP" reads identically in both places. */}
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t('API_KEYS_CREATE_SCOPE_LABEL')}</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary" data-testid="api-key-create-scope">
                {t('API_KEYS_SCOPE_MCP')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{t('API_KEYS_CREATE_SCOPE_HINT')}</p>
          </div>
          {/* What the key may do IS a choice, at the moment the key is minted — so a key made for a
              third-party client that only needs to read is never wide open in between. */}
          <CapabilityPicker name="api-key-new" value={newKeyCapability} onChange={setNewKeyCapability} disabled={creatingKey} />
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

      {/* Capability-change dialog: pick a level, then confirm if the change grants authority. */}
      <Dialog open={Boolean(changeTarget)} onOpenChange={(open) => !open && closeCapabilityChange()}>
        <DialogContent>
          {changeStep === 'choose' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('API_KEYS_CAPABILITY_CHANGE_TITLE', { name: changeTarget?.name ?? '' })}</DialogTitle>
                <DialogDescription>{t('API_KEYS_CAPABILITY_CHANGE_DESC')}</DialogDescription>
              </DialogHeader>
              <CapabilityPicker name="api-key-change" value={changeTo} onChange={setChangeTo} disabled={savingCapability} />
              {/* A managed key belongs to an installed app, and tightening it is a decision about
                  that app's behaviour — so say which app, rather than letting the operator discover
                  it when the app stops working. */}
              {changeTarget?.managed && (
                <p className="text-xs text-muted-foreground" data-testid="api-key-change-managed-warning">
                  {t('API_KEYS_CAPABILITY_MANAGED_WARNING', { app: changeTarget.ownerAppUrn ?? changeTarget.name })}
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={closeCapabilityChange}>
                  {t('COMMON_CANCEL')}
                </Button>
                <Button
                  loading={savingCapability}
                  disabled={savingCapability || changeTo === changeTarget?.capability}
                  onClick={() => void submitCapability()}
                  data-testid="api-key-change-submit"
                >
                  {t('COMMON_SAVE')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                {/* The key is named in the title: an operator with several keys must not be able to
                    promote the wrong one because the dialog only said "this key". */}
                <DialogTitle>{t(confirmTitleKey, { name: changeTarget?.name ?? '' })}</DialogTitle>
                <DialogDescription>{t(confirmBodyKey)}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setChangeStep('choose')}>
                  {t('COMMON_BACK')}
                </Button>
                <Button
                  variant={changeTo === 'full' ? 'destructive' : 'default'}
                  loading={savingCapability}
                  disabled={savingCapability}
                  onClick={() => void submitCapability()}
                  data-testid="api-key-change-confirm"
                >
                  {t('API_KEYS_CAPABILITY_CONFIRM')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
};
