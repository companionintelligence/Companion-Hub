import { type ApiKeyCapability, CapabilityBadge, isCapabilityPromotion } from '@/components/capability-badge/capability-badge';
import { CapabilityPicker } from '@/components/capability-badge/capability-picker';
import { ScopeBadge } from '@/components/scope-badge/scope-badge';
import { formatHubDateTime } from '@/components/ui/dense/dense';
import { OPERATOR_MINTABLE_SCOPES, type OperatorMintableScope } from '@ci-hub/common/types';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { isI18nKey } from '@/lib/format-api-error';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
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

/**
 * Whether this operator may give a key full capability. Asked on its own because answering it asks
 * the Portal, and the list must not wait on that. Any failure (a Hub that predates the route, an
 * outage) reads as yes: the screen then offers full as it always did, and the routes decide.
 */
const fetchCanGrantFull = async (): Promise<boolean> => {
  try {
    const res = await apiFetch('/api/api-keys/grantable');
    if (!res.ok) {
      return true;
    }
    return ((await res.json()) as { canGrantFull?: boolean }).canGrantFull !== false;
  } catch {
    return true;
  }
};

/**
 * The server's own reason for a refusal, translated, when it sent one — "only an owner or admin can
 * give a key full capability" says what to do next, a generic "could not save" does not.
 *
 * Only a translation key is a reason. Raw backend text — a validation failure's "Bad Request
 * Exception", a 503's "Database temporarily unavailable" — is not copy for the screen, so it gets
 * `fallback`, and so does a body that is not JSON at all.
 */
const refusalMessage = async (res: Response, t: TFunction, fallback: string): Promise<string> => {
  try {
    const body = (await res.json()) as { message?: unknown; intlParams?: Record<string, string> };
    if (typeof body.message === 'string' && isI18nKey(body.message)) {
      return t(body.message, { ...(body.intlParams ?? {}), defaultValue: fallback });
    }
  } catch {
    // Not JSON: a proxy's error page, say.
  }
  return fallback;
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
  const [newKeyScope, setNewKeyScope] = useState<OperatorMintableScope>('mcp');
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
  // Whether this operator may give a key full capability — an organization owner or admin. The routes
  // decide regardless; this only keeps the screen from offering a choice the Hub will refuse.
  const [canGrantFull, setCanGrantFull] = useState(true);

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

  // Who may give full capability is asked on mount and again after a refusal, never on the list's own
  // refreshes, so the Portal hears about this operator once per visit rather than once per action.
  const loadGrantable = useCallback(async () => {
    setCanGrantFull(await fetchCanGrantFull());
  }, []);

  useEffect(() => {
    void loadGrantable();
  }, [loadGrantable]);

  const openCreate = useCallback(() => {
    setNewKeyName('');
    // Reset to the default every time: a level chosen for the last key must not silently carry over
    // into the next one, least of all 'full'.
    setNewKeyCapability('write');
    setNewKeyScope('mcp');
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
        body: JSON.stringify({ name, capability: newKeyCapability, scope: newKeyScope }),
      });
      if (!res.ok) {
        // A refusal says why — only an owner or admin can give a key full capability — not just "failed".
        toast.error(await refusalMessage(res, t, t('API_KEYS_CREATE_ERROR')));
        // It can also mean what this screen thinks the operator may grant is out of date (their role
        // changed since the page loaded), so re-read it rather than keep offering the refused level.
        await loadGrantable();
        return;
      }
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
  }, [newKeyName, newKeyCapability, newKeyScope, refreshKeys, loadGrantable, t]);

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
      if (!res.ok) {
        toast.error(await refusalMessage(res, t, t('API_KEYS_CAPABILITY_SAVE_ERROR')));
        // Back to the picker, re-read: a refused promotion must not leave the confirmation up, offering
        // the level the Hub just refused.
        setChangeStep('choose');
        await loadGrantable();
        return;
      }
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
  }, [changeTarget, changeTo, changeStep, closeCapabilityChange, refreshKeys, loadGrantable, t]);

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
  // A managed key's level also decides how far it reaches the apps beside its own, so its confirmation
  // says that, and names the app it belongs to.
  const confirmTitleKey = changeTo === 'full' ? 'API_KEYS_CAPABILITY_CONFIRM_FULL_TITLE' : 'API_KEYS_CAPABILITY_CONFIRM_WRITE_TITLE';
  const confirmBodyKey = changeTarget?.managed
    ? changeTo === 'full'
      ? 'API_KEYS_CAPABILITY_CONFIRM_MANAGED_FULL_BODY'
      : 'API_KEYS_CAPABILITY_CONFIRM_MANAGED_WRITE_BODY'
    : changeTo === 'full'
      ? 'API_KEYS_CAPABILITY_CONFIRM_FULL_BODY'
      : 'API_KEYS_CAPABILITY_CONFIRM_WRITE_BODY';

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
                        {key.lastUsedAt ? t('API_KEYS_LAST_USED', { when: formatHubDateTime(key.lastUsedAt) }) : t('API_KEYS_NEVER_USED')}
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
          {/* Which SURFACE the key opens. Two choices, not four: an operator-created 'app' key would
              have no owning app URN and could never pass the callback guard's identity check, and
              'qa:read' is minted over ssh on the node under test. Offering either here would only
              mint a credential that authenticates nothing, or invite 'qa:read' as a "safer MCP key"
              when it is a different surface. */}
          {/* Native radios in a fieldset, matching CapabilityPicker below: these are two different
              surfaces rather than interchangeable settings, and the hint under them is the sentence
              that makes the choice an informed one. */}
          <fieldset className="min-w-0 space-y-1" data-testid="api-key-create-scope">
            <legend className="text-sm font-medium">{t('API_KEYS_CREATE_SCOPE_LABEL')}</legend>
            <div className="flex flex-wrap gap-4">
              {OPERATOR_MINTABLE_SCOPES.map((scope) => (
                <label key={scope} className="flex cursor-pointer items-center gap-2" htmlFor={`api-key-new-scope-${scope}`}>
                  <input
                    id={`api-key-new-scope-${scope}`}
                    type="radio"
                    name="api-key-new-scope"
                    value={scope}
                    checked={newKeyScope === scope}
                    disabled={creatingKey}
                    onChange={() => setNewKeyScope(scope)}
                    data-testid={`api-key-create-scope-${scope}`}
                  />
                  <span className="text-sm">{t(scope === 'mcp' ? 'API_KEYS_SCOPE_MCP' : 'API_KEYS_SCOPE_INFERENCE')}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(newKeyScope === 'mcp' ? 'API_KEYS_CREATE_SCOPE_HINT' : 'API_KEYS_CREATE_SCOPE_INFERENCE_HINT')}
            </p>
          </fieldset>
          {/* What the key may do IS a choice, at the moment the key is minted — so a key made for a
              third-party client that only needs to read is never wide open in between.
              Hidden for an inference key: capability grades the MCP TOOL surface, and that key
              reaches no tool, so every level would mean the same thing. Showing a control that
              changes nothing is worse than showing none. */}
          {newKeyScope === 'mcp' && (
            <CapabilityPicker
              name="api-key-new"
              value={newKeyCapability}
              onChange={setNewKeyCapability}
              disabled={creatingKey}
              unavailable={canGrantFull ? [] : ['full']}
              unavailableHint={t('API_KEY_FULL_ROLE_REQUIRED')}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateKeyOpen(false)}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              loading={creatingKey}
              // Never send a level the Hub has said it will refuse: after a refusal the re-read can take
              // `full` away while it is still the selected choice.
              disabled={creatingKey || !newKeyName.trim() || (newKeyScope === 'mcp' && !canGrantFull && newKeyCapability === 'full')}
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
              <CapabilityPicker
                name="api-key-change"
                value={changeTo}
                onChange={setChangeTo}
                disabled={savingCapability}
                managed={Boolean(changeTarget?.managed)}
                unavailable={canGrantFull ? [] : ['full']}
                unavailableHint={t('API_KEY_FULL_ROLE_REQUIRED')}
              />
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
                  disabled={savingCapability || changeTo === changeTarget?.capability || (!canGrantFull && changeTo === 'full')}
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
                <DialogDescription>{t(confirmBodyKey, { app: changeTarget?.ownerAppUrn ?? changeTarget?.name ?? '' })}</DialogDescription>
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
