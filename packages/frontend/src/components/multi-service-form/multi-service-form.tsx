import './services-form.css';
import { Button } from '@/components/ui/Button';
import { zodResolver } from '@hookform/resolvers/zod';
import { dynamicComposeFormSchema, type dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import { ArrowUpDown, Network, Plus, Server, Settings, Variable, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { JsonComposeEditor } from './json-compose-editor';
import { useMultiServiceStore } from '@/stores/multiServiceStore';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AdvancedConfig } from './elements/advanced';
import { PortsConfig } from './elements/ports';
import { VolumesConfig } from './elements/volumes';
import { EnvironmentConfig } from './elements/environment';
import { EssentialConfig } from './elements/essential';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18next from 'i18next';
import { deepClean } from '@/utils/objects';

type Props = {
  /** Saves the app. While the promise it returns is pending, Save all and Save JSON stay disabled. */
  onSubmit?: (data: z.infer<typeof dynamicComposeSchema>) => unknown;
};

const cleanSchema = dynamicComposeFormSchema.transform((d) => deepClean(d));

export const MultiServiceForm = ({ onSubmit }: Props) => {
  const { t } = useTranslation();
  const { services, updateFromJson, activeService, setActiveService, addService, removeService, updateService, validate, isDirty, setIsDirty } =
    useMultiServiceStore();
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [json, setJson] = useState<{ value: string; error?: string }>({
    value: '',
    error: undefined,
  });
  const [activeTab, setActiveTab] = useState('essentials');
  // One save at a time: a double click on Save all or Save JSON sent the same request twice. The ref
  // stops the second click before React has re-rendered the disabled button.
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const oneSaveAtATime = async (save: () => Promise<void>) => {
    if (saving.current) {
      return;
    }
    saving.current = true;
    setIsSaving(true);
    try {
      await save();
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  const tabs = [
    {
      id: 'essentials',
      label: t('MULTI_SERVICE_TAB_ESSENTIALS'),
      icon: Server,
    },
    {
      id: 'environment',
      label: t('MULTI_SERVICE_TAB_ENVIRONMENT'),
      icon: Variable,
    },
    { id: 'volumes', label: t('MULTI_SERVICE_TAB_VOLUMES'), icon: Network },
    {
      id: 'ports',
      label: t('COMMON_PORTS'),
      icon: ArrowUpDown,
    },
    {
      id: 'advanced',
      label: t('COMMON_ADVANCED'),
      icon: Settings,
    },
  ];

  const form = useForm<z.infer<typeof dynamicComposeSchema>>({
    // biome-ignore lint/suspicious/noExplicitAny: schema type coercion for resolver
    resolver: zodResolver(cleanSchema as any),
    defaultValues: {
      services,
    },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  // biome-ignore lint/suspicious/noExplicitAny: We need any type here
  function saveBeforeAction<T extends (...args: any[]) => any>(action: T) {
    return (...args: Parameters<T>): ReturnType<T> => {
      if (isDirty && jsonEditorOpen) {
        const confirmLeave = window.confirm(t('MULTI_SERVICE_UNSAVED_CHANGES_CONFIRM'));
        if (!confirmLeave) {
          return undefined as ReturnType<T>;
        }

        setIsDirty(false);
      }

      const values = form.getValues();
      values.services.forEach((service, index) => {
        updateService(index, service);
      });

      return action(...args);
    };
  }

  useEffect(() => {
    form.setValue('services', services);
  }, [services, form.setValue]);

  const hasSectionErrors = (section: string, index: number): boolean => {
    const serviceErrors = form.formState.errors?.services?.[index];
    if (!serviceErrors) return false;

    switch (section) {
      case 'essentials':
        return Boolean(serviceErrors.name || serviceErrors.image || serviceErrors.internalPort);
      case 'environment':
        return Boolean(
          serviceErrors.environment && Array.isArray(serviceErrors.environment) && serviceErrors.environment.some((env) => env?.key || env?.value),
        );
      case 'volumes':
        return Boolean(
          serviceErrors.volumes && Array.isArray(serviceErrors.volumes) && serviceErrors.volumes.some((vol) => vol?.hostPath || vol?.containerPath),
        );
      case 'ports':
        return Boolean(
          serviceErrors.addPorts &&
            Array.isArray(serviceErrors.addPorts) &&
            serviceErrors.addPorts.some((port) => port?.hostPort || port?.containerPort || port?.interface),
        );
      case 'advanced':
        return Boolean(
          serviceErrors.networkMode || serviceErrors.workingDir || serviceErrors.user || serviceErrors.hostname || serviceErrors.privileged,
        );
      default:
        return false;
    }
  };

  const serviceHasError = (index: number): boolean => {
    return Boolean(form.formState.errors.services?.[index]);
  };

  const renderTab = (tabId: string, label: string, IconComponent: typeof Settings, index: number) => {
    const isActive = activeTab === tabId;

    return (
      <li className="shrink-0" key={tabId}>
        <button
          type="button"
          aria-pressed={isActive}
          className={clsx(
            'inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all',
            'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            isActive ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
          )}
          onClick={() => setActiveTab(tabId)}
        >
          <IconComponent size={16} aria-hidden="true" />
          <span>{label}</span>
          {hasSectionErrors(tabId, index) && <span className="ms-1 text-destructive">*</span>}
        </button>
      </li>
    );
  };

  const handleSubmit = async (formData: z.infer<typeof dynamicComposeSchema>) => {
    // The form has no fields for the per-architecture overrides, so they come from the store: the saved
    // config's, or the ones typed in the JSON editor. Without them a save dropped the block.
    const { overrides } = useMultiServiceStore.getState();
    const data = overrides ? { ...formData, overrides } : formData;
    const valid = validate(data);

    if (valid) {
      await onSubmit?.(data);
    } else {
      const latestError = useMultiServiceStore.getState().error;
      toast.error(i18next.exists(latestError) ? t(latestError) : latestError);
    }
  };

  // The form's own check refused a field. The store's check says which rule and where, as it does
  // for the JSON editor, rather than a bare "Invalid configuration.".
  const handleInvalid = () => {
    const { overrides } = useMultiServiceStore.getState();
    const values = form.getValues();
    validate(overrides ? { ...values, overrides } : values);
    const latestError = useMultiServiceStore.getState().error || 'MULTI_SERVICE_ERROR_INVALID_CONFIGURATION';
    toast.error(i18next.exists(latestError) ? t(latestError) : latestError);
  };

  // Save JSON stores what the editor holds through onSubmit, as Save all does. Copying it into the form
  // alone loses the change as soon as the page is left.
  const saveJson = async () => {
    form.clearErrors();

    let parsed: Partial<Pick<z.infer<typeof dynamicComposeSchema>, 'services' | 'overrides'>>;
    try {
      parsed = JSON.parse(json.value);
    } catch {
      toast.error(t('MULTI_SERVICE_JSON_INVALID_FORMAT'));
      return;
    }

    const applied = updateFromJson({ services: parsed.services ?? [], overrides: parsed.overrides });
    if (!applied) {
      return;
    }

    if (!onSubmit) {
      toast.success(t('MULTI_SERVICE_JSON_UPDATE_SUCCESS'));
      return;
    }

    form.setValue('services', applied);
    await form.handleSubmit(handleSubmit, handleInvalid)();
  };

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void oneSaveAtATime(() => form.handleSubmit(handleSubmit, handleInvalid)());
      }}
    >
      <div className="bg-card border rounded-lg mt-4 m-0 p-0">
        {jsonEditorOpen && <JsonComposeEditor onChange={(json, jsonError) => setJson({ value: json, error: jsonError })} />}
        {!jsonEditorOpen && (
          <div className="flex flex-col md:flex-row">
            <div className="w-full shrink-0 border-b border-border p-0 md:w-1/6 md:border-r md:border-b-0">
              <div className="flex items-center justify-between p-3">
                <div className="font-semibold">{t('MULTI_SERVICE_SERVICES')}</div>
                <button
                  type="button"
                  className="rounded-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('MULTI_SERVICE_ADD_SERVICE')}
                  onClick={() => saveBeforeAction(addService)()}
                >
                  <Plus aria-hidden size={20} />
                </button>
              </div>
              <div className="w-full border-t border-border">
                <div className="flex flex-col">
                  {services.map((service, index) => (
                    <button
                      type="button"
                      key={service._id}
                      className={clsx(
                        'flex w-full cursor-pointer items-center px-3 py-2 text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                        index === activeService ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
                      )}
                      onClick={() => saveBeforeAction(setActiveService)(index)}
                    >
                      <div className="flex w-full items-center justify-between">
                        <div className="truncate">
                          <span>
                            {service.name ||
                              t('MULTI_SERVICE_SERVICE_NAME', {
                                index: index + 1,
                              })}
                          </span>
                          {serviceHasError(index) && <span className="ms-1 text-destructive">*</span>}
                        </div>
                        {!service.isMain && (
                          <button
                            type="button"
                            className="ms-2 shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('MULTI_SERVICE_REMOVE_SERVICE')}
                            onClick={(e) => {
                              e.stopPropagation();
                              saveBeforeAction(removeService)(index);
                            }}
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="w-full min-w-0 md:w-5/6">
              <div className="px-3 pt-3">
                <ul className="inline-flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-md border border-border/50 bg-muted p-1">
                  {activeService !== 'json' && services[activeService] && tabs.map((tab) => renderTab(tab.id, tab.label, tab.icon, activeService))}
                </ul>
              </div>
              <div className="pt-4 px-3 pb-5">
                {services.map((service, index) => {
                  return (
                    <div key={service._id} className={clsx({ hidden: index !== activeService })}>
                      <div
                        className={clsx({
                          hidden: activeTab !== 'essentials',
                        })}
                      >
                        <EssentialConfig register={form.register} serviceIndex={index} errors={form.formState.errors} />
                      </div>
                      <div
                        className={clsx({
                          hidden: activeTab !== 'environment',
                        })}
                      >
                        <EnvironmentConfig control={form.control} register={form.register} serviceIndex={index} errors={form.formState.errors} />
                      </div>
                      <div className={clsx({ hidden: activeTab !== 'volumes' })}>
                        <VolumesConfig control={form.control} register={form.register} serviceIndex={index} errors={form.formState.errors} />
                      </div>
                      <div className={clsx({ hidden: activeTab !== 'ports' })}>
                        <PortsConfig control={form.control} register={form.register} serviceIndex={index} errors={form.formState.errors} />
                      </div>
                      <div className={clsx({ hidden: activeTab !== 'advanced' })}>
                        <AdvancedConfig register={form.register} serviceIndex={index} errors={form.formState.errors} control={form.control} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between rounded-b-lg border-t border-border p-3">
          <Button disabled={jsonEditorOpen || isSaving} type="submit" className={clsx({ hidden: jsonEditorOpen })}>
            {t('MULTI_SERVICE_VALIDATE_ALL_SERVICES')}
          </Button>
          <Button
            className={clsx({ hidden: !jsonEditorOpen })}
            type="button"
            disabled={Boolean(json.error) || isSaving}
            onClick={() => void oneSaveAtATime(saveJson)}
          >
            {t('MULTI_SERVICE_JSON_SAVE')}
          </Button>
          <div
            className={clsx('text-center text-sm text-muted-foreground', {
              hidden: !jsonEditorOpen,
            })}
          >
            <a
              href="https://docs.ci.computer"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              {t('MULTI_SERVICE_JSON_REFERENCE')}
            </a>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              saveBeforeAction(setJsonEditorOpen)((v) => !v);
            }}
          >
            <span className="flex items-center">{jsonEditorOpen ? t('MULTI_SERVICE_BACK_TO_FORM') : t('MULTI_SERVICE_JSON_EDITOR')}</span>
          </Button>
        </div>
      </div>
    </form>
  );
};
