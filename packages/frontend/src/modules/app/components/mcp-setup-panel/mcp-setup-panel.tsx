import type { AppInfo } from '@/types/app.types';
import { buildMcpInstallSchema, type McpInstallSchema } from '@ci-hub/common/validation';
import { Plug, Server } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  info: AppInfo;
  /** Pre-computed schema from API when available. */
  installSchema?: McpInstallSchema | null;
}

/**
 * Summarizes MCP install requirements in the install dialog — transport, env vars, and notes.
 */
export function McpSetupPanel({ info, installSchema }: Props) {
  const { t } = useTranslation();
  const schema = useMemo(() => installSchema ?? buildMcpInstallSchema(info), [info, installSchema]);

  if (!schema) return null;

  return (
    <div className="mb-4 rounded-md border border-violet-500/30 bg-violet-500/5 p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Plug className="h-4 w-4 text-violet-500" />
        {t('APP_MCP_SETUP_TITLE', { defaultValue: 'MCP setup' })}
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        {t('APP_MCP_SETUP_DESC', {
          defaultValue: 'This app runs as an MCP server. Configure optional credentials below or install with defaults.',
        })}
      </p>
      <dl className="grid gap-2 text-sm">
        <div className="flex gap-2">
          <dt className="flex items-center gap-1 font-medium text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {t('APP_MCP_SETUP_TRANSPORT', { defaultValue: 'Transport' })}
          </dt>
          <dd className="font-mono text-xs uppercase">{schema.transport}</dd>
        </div>
        {schema.fields.length > 0 && (
          <div>
            <dt className="mb-1 font-medium text-muted-foreground">{t('APP_MCP_SETUP_ENV', { defaultValue: 'Configuration' })}</dt>
            <dd>
              <ul className="space-y-1">
                {schema.fields.map((field) => (
                  <li key={field.key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{field.key}</code>
                    <span>{field.label}</span>
                    {field.required ? (
                      <span className="text-xs text-danger">{t('COMMON_REQUIRED', { defaultValue: 'Required' })}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('COMMON_OPTIONAL', { defaultValue: 'Optional' })}</span>
                    )}
                    {field.default !== undefined && field.default !== '' ? (
                      <span className="text-xs text-muted-foreground">
                        {t('APP_MCP_SETUP_DEFAULT', { defaultValue: 'Default' })}: {String(field.default)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {schema.requires?.notes ? (
          <div>
            <dt className="font-medium text-muted-foreground">{t('COMMON_NOTES', { defaultValue: 'Notes' })}</dt>
            <dd className="text-muted-foreground">{schema.requires.notes}</dd>
          </div>
        ) : null}
        {!schema.bridgeable && schema.bridgeWarning ? <p className="text-xs text-amber-600 dark:text-amber-500">{schema.bridgeWarning}</p> : null}
      </dl>
    </div>
  );
}
