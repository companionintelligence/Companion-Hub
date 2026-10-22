import { create } from 'zustand';
import type { z } from 'zod';
import { dynamicComposeFormSchema, type dynamicComposeSchema, type ServiceInput } from '@ci-hub/common/schemas';
import { toast } from 'sonner';
import i18next from 'i18next';

type MultiServiceFormData = z.infer<typeof dynamicComposeSchema>;
type ServiceFormData = ServiceInput;

interface ServiceWithId extends ServiceFormData {
  _id: string;
}

interface MultiServiceState {
  // State
  services: ServiceWithId[];
  /** The compose's per-architecture overrides. The form has no fields for them, so they travel beside it: from the saved config, or typed in the JSON editor. */
  overrides: MultiServiceFormData['overrides'];
  activeService: number | 'json';
  isDirty: boolean;
  error: string;
  validate: (values: z.infer<typeof dynamicComposeSchema>) => boolean;

  // Actions
  setActiveService: (tab: number) => void;
  addService: () => void;
  removeService: (index: number) => void;
  updateService: (index: number, serviceData: ServiceFormData) => void;
  /** Puts the JSON editor's services and overrides into the form. Returns the services, or null (after a toast) when they fail validation. */
  updateFromJson: (compose: Pick<MultiServiceFormData, 'services' | 'overrides'>) => ServiceWithId[] | null;
  resetToDefaults: () => void;
  setIsDirty: (dirty: boolean) => void;
  setServices: (services: ServiceWithId[]) => void;
  setOverrides: (overrides: MultiServiceFormData['overrides']) => void;
}

const defaultService: ServiceFormData = {
  name: '',
  image: '',
  isMain: false,
  internalPort: 80,
  environment: [],
  volumes: [],
  addPorts: [],
};

const defaultServices: ServiceWithId[] = [
  {
    _id: generateId(),
    name: 'web',
    image: 'nginx:alpine',
    isMain: true,
    internalPort: 80,
  },
];

type ComposeIssue = { message: string; path: PropertyKey[]; params?: Record<string, unknown> };

/**
 * The first refusal the schema gave, as a sentence that names the rule and where it was broken:
 * "Service web in the arm64 override: A custom app can't run a privileged container." Falls back to
 * "Invalid configuration." when no issue carries a message the Hub has words for.
 */
function describeComposeIssue(issues: readonly ComposeIssue[], values: Partial<MultiServiceFormData>): string {
  const issue = issues.find((candidate) => i18next.exists(candidate.message));
  if (!issue) {
    return 'MULTI_SERVICE_ERROR_INVALID_CONFIGURATION';
  }

  const rule = i18next.t(issue.message, { ...issue.params });
  const [section, index, inner, innerIndex] = issue.path;
  if (section === 'services' && typeof index === 'number') {
    const service = values.services?.[index]?.name || String(index + 1);
    return i18next.t('MULTI_SERVICE_ERROR_IN_SERVICE', { service, message: rule });
  }
  if (section === 'overrides' && typeof index === 'number' && inner === 'services' && typeof innerIndex === 'number') {
    const override = values.overrides?.[index];
    const service = override?.services?.[innerIndex]?.name || String(innerIndex + 1);
    return override?.architecture
      ? i18next.t('MULTI_SERVICE_ERROR_IN_OVERRIDE', { service, architecture: override.architecture, message: rule })
      : i18next.t('MULTI_SERVICE_ERROR_IN_ANY_OVERRIDE', { service, message: rule });
  }
  return rule;
}

function generateId(): string {
  return `service-${Math.random().toString(36).substring(2, 9)}`;
}

export const useMultiServiceStore = create<MultiServiceState>()((set, get) => ({
  services: defaultServices,
  overrides: undefined,
  activeService: 0,
  isDirty: false,
  error: '',
  setServices: (services: ServiceWithId[]) => set({ services }),
  setOverrides: (overrides: MultiServiceFormData['overrides']) => set({ overrides }),
  validate: (values: z.infer<typeof dynamicComposeSchema>) => {
    const res = dynamicComposeFormSchema.safeParse(values);

    if (!res.success) {
      set({ error: describeComposeIssue(res.error.issues, values) });
      return false;
    }

    // Ensure only one main service
    const mainServices = values.services.filter((service) => service.isMain);
    if (mainServices.length !== 1) {
      set({ error: 'MULTI_SERVICE_ERROR_SINGLE_MAIN_SERVICE' });
      return false;
    }

    // Ensure unique service names
    const names = values.services.map((service) => service.name);
    const uniqueNames = new Set(names);
    if (names.length !== uniqueNames.size) {
      set({ error: 'MULTI_SERVICE_ERROR_UNIQUE_SERVICE_NAMES' });
      return false;
    }

    set({ error: '' });
    return true;
  },
  setActiveService: (tab: number | 'json') => {
    const { activeService, isDirty } = get();

    if (activeService === 'json' && isDirty && tab !== 'json') {
      if (!window.confirm(i18next.t('MULTI_SERVICE_JSON_LOSE_CHANGES_CONFIRM'))) {
        return;
      }
    }

    set({ activeService: tab, isDirty: false });
  },

  addService: () => {
    const { services, activeService, isDirty } = get();
    if (activeService === 'json' && isDirty) {
      if (!window.confirm(i18next.t('MULTI_SERVICE_JSON_LOSE_CHANGES_CONFIRM'))) {
        return;
      }
    }

    const newService: ServiceWithId = {
      ...defaultService,
      _id: generateId(),
      name: `service-${services.length + 1}`,
    };
    const newServices = [...services, newService];

    set({
      isDirty: false,
      services: newServices,
      activeService: services.length,
    });

    get().validate({ schemaVersion: 2, services: newServices });
  },

  removeService: (index: number) => {
    const { activeService, isDirty, services } = get();
    if (activeService === 'json' && isDirty) {
      if (!window.confirm(i18next.t('MULTI_SERVICE_JSON_LOSE_CHANGES_CONFIRM'))) {
        return;
      }
    }

    if (services.length === 1) return;

    const newServices = services.filter((_, i) => i !== index);
    let newActiveTab = activeService;

    if (activeService === index || activeService === 'json') {
      newActiveTab = 0;
    } else if (activeService > index) {
      newActiveTab = activeService - 1;
    }

    set({
      isDirty: false,
      services: newServices,
      activeService: newActiveTab,
    });
    get().validate({ schemaVersion: 2, services: newServices });
  },

  updateService: (index: number, serviceData: ServiceFormData) => {
    const { services } = get();
    const existingService = services[index];

    if (existingService) {
      const newServices = [...services];
      newServices[index] = { ...serviceData, _id: existingService._id };
      set({ services: newServices });
      get().validate({ schemaVersion: 2, services: newServices });
    }
  },

  updateFromJson: ({ services: newServices, overrides }) => {
    const servicesWithIds = newServices.map((service, index) => ({
      ...service,
      _id: get().services[index]?._id || generateId(),
    }));

    get().validate({ schemaVersion: 2, services: servicesWithIds, overrides });

    const error = get().error;
    if (error) {
      toast.error(i18next.exists(error) ? i18next.t(error) : error);
      return null;
    }

    set({ services: servicesWithIds, overrides, isDirty: false });
    return servicesWithIds;
  },
  resetToDefaults: () =>
    set({
      services: defaultServices.map((service) => ({ ...service, _id: generateId() })),
      overrides: undefined,
      activeService: 0,
      error: '',
      isDirty: false,
    }),

  setIsDirty: (dirty: boolean) => set({ isDirty: dirty }),
}));
