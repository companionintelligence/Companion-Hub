import { Switch } from '@/components/ui/Switch';
import type { MemoryConsumer } from '@/modules/app/helpers/use-memory-connection';
import type React from 'react';
import { useTranslation } from 'react-i18next';

interface IProps {
  /** Installed apps still connected to Companion Memory. */
  consumers: MemoryConsumer[];
  /** True when the connected-app list couldn't be fetched (show a generic warning, still gate). */
  unableToVerify?: boolean;
  /** Whether the user has acknowledged the forced removal. */
  forceConfirmed: boolean;
  onForceConfirmedChange: (checked: boolean) => void;
  /** Distinct name for the confirm switch (drives its id/label association). */
  switchName: string;
}

/**
 * Shared danger block shown when uninstalling or resetting the shared Companion
 * Memory provider while consumer apps are still connected: lists the affected
 * apps and gates the action behind an explicit confirmation switch. Kept in one
 * place so the uninstall and reset dialogs can't drift apart. When the consumer
 * list couldn't be fetched (`unableToVerify`), it shows a generic warning and
 * still requires the confirmation rather than pretending nothing is connected.
 */
export const MemoryProviderForceWarning: React.FC<IProps> = ({ consumers, unableToVerify, forceConfirmed, onForceConfirmedChange, switchName }) => {
  const { t } = useTranslation();

  return (
    <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-start">
      {unableToVerify ? (
        <p className="font-medium text-destructive">{t('APP_UNINSTALL_MEMORY_PROVIDER_UNKNOWN')}</p>
      ) : (
        <>
          <p className="font-medium text-destructive">{t('APP_UNINSTALL_MEMORY_PROVIDER_WARNING', { count: consumers.length })}</p>
          <ul className="mt-1 list-disc ps-5 text-muted-foreground">
            {consumers.map((c) => (
              <li key={c.appUrn}>{c.name}</li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-muted-foreground">{t('APP_UNINSTALL_MEMORY_PROVIDER_CONSEQUENCE')}</p>
      <div className="mt-3">
        <Switch
          name={switchName}
          checked={forceConfirmed}
          onCheckedChange={onForceConfirmedChange}
          label={t('APP_UNINSTALL_MEMORY_PROVIDER_FORCE_LABEL')}
        />
      </div>
    </div>
  );
};
