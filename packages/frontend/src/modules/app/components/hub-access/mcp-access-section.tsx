import { client } from '@/api-client/client.gen';
import { CAPABILITY_LABEL_KEYS } from '@/components/capability-badge/capability-badge';
import { McpAccessPicker } from '@/components/capability-badge/mcp-access-picker';
import { Button } from '@/components/ui/Button';
import { formatApiError, isConflictError } from '@/lib/format-api-error';
import { useCanGrantFull } from '@/lib/hooks/use-can-grant-full';
import { useHubAccess } from '@/lib/hooks/use-hub-access';
import { asLegacyTranslate } from '@/lib/i18n/legacy-translate';
import type { McpAccessChoice } from '@ci-hub/common/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { HubAccessStatus } from './hub-access';

interface McpAccessSectionProps {
  appUrn: string;
  mcp: NonNullable<HubAccessStatus['mcp']>;
  queryKey: readonly unknown[];
  /** Saving restarts a running app, which would drop the settings form's unsaved edits. */
  hasUnsavedChanges: boolean;
}

/**
 * The app's request for the Hub's MCP tools and the answer to it (`PUT /api/app-lifecycle/:urn/hub-access/mcp`).
 * Only someone who may manage the Hub may answer, and `full` takes an organization owner or admin; the
 * route decides, and the picker shows who may so nobody meets a button that is refused.
 */
export const McpAccessSection = ({ appUrn, mcp, queryKey, hasUnsavedChanges }: McpAccessSectionProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { manageHub } = useHubAccess();
  const canGrantFull = useCanGrantFull({ enabled: manageHub });
  const [selected, setSelected] = useState<McpAccessChoice>(mcp.access ?? 'none');

  const save = useMutation({
    mutationFn: async (access: McpAccessChoice) => {
      const { data } = await client.put({
        url: `/api/app-lifecycle/${encodeURIComponent(appUrn)}/hub-access/mcp`,
        body: { access },
        headers: { 'Content-Type': 'application/json' },
        throwOnError: true,
      });
      return data as { restarting?: boolean } | undefined;
    },
    onSuccess: async (data) => {
      toast.success(t(data?.restarting ? 'APP_MCP_ACCESS_SAVED_RESTARTING' : 'APP_MCP_ACCESS_SAVED'));
      await queryClient.invalidateQueries({ queryKey });
    },
    // A 409 names the operation holding the app; nothing was saved.
    onError: (error) => toast.error(isConflictError(error) ? formatApiError(error, asLegacyTranslate(t), 409) : t('APP_MCP_ACCESS_ERROR')),
  });

  // An answer of none and no answer at all both mean no key, but only a saved `none` is an answer.
  const unchanged = mcp.access !== null && selected === mcp.access;

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3" data-testid="hub-access-mcp">
      <p className="text-sm font-medium">{t('APP_MCP_ACCESS_TITLE')}</p>
      <p className="text-xs text-muted-foreground">{t('APP_MCP_ACCESS_DESC')}</p>
      {mcp.access === null && (
        <p className="text-xs text-warning" data-testid="hub-access-mcp-unanswered">
          {t('APP_MCP_ACCESS_NOT_ANSWERED')}
        </p>
      )}
      <McpAccessPicker
        name="hub-access"
        value={selected}
        onChange={setSelected}
        disabled={!manageHub || save.isPending}
        unavailable={canGrantFull ? [] : ['full']}
        unavailableHint={t('APP_MCP_ACCESS_FULL_ROLE_REQUIRED')}
      />
      {!manageHub && <p className="text-xs text-muted-foreground">{t('APP_MCP_ACCESS_MANAGER_REQUIRED')}</p>}
      {mcp.keyCapability && mcp.keyCapability !== mcp.access && (
        <p className="text-xs text-muted-foreground" data-testid="hub-access-mcp-key-level">
          {t('APP_MCP_ACCESS_KEY_LEVEL', {
            level: t(CAPABILITY_LABEL_KEYS[mcp.keyCapability as keyof typeof CAPABILITY_LABEL_KEYS] ?? mcp.keyCapability),
          })}
        </p>
      )}
      {manageHub && (
        <div className="flex justify-end">
          {/* type="button": this sits inside the settings dialog, whose form a default button would submit. */}
          <Button
            type="button"
            size="sm"
            disabled={unchanged || save.isPending || hasUnsavedChanges}
            onClick={() => save.mutate(selected)}
            data-testid="hub-access-mcp-save"
          >
            {t('APP_MCP_ACCESS_SAVE')}
          </Button>
        </div>
      )}
    </div>
  );
};
