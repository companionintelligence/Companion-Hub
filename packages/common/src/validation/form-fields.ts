import type { FormField } from '../schemas/app-info.js';
import validator from 'validator';

export type FormFieldValidationError = {
  env_variable: string;
  label: string;
  messageKey: string;
  params?: Record<string, string>;
};

/** Reserved install-form keys stripped before field validation. */
export const INSTALL_FORM_META_KEYS = [
  'exposed',
  'exposedLocal',
  'openPort',
  'domain',
  'localSubdomain',
  'port',
  'exposureMode',
  'enableAuth',
  'publicDomain',
  'customDomain',
  'maxBackups',
  'cpuLimit',
  'isVisibleOnGuestDashboard',
  'skipRun',
] as const;

export const HIDDEN_FIELD_TYPES = ['random'] as const;

const isGenericUrl = (value: string) => validator.isURL(value);

const isAppBaseUrl = (value: string) =>
  validator.isURL(value, {
    require_protocol: true,
    require_tld: false,
  });

/** Resolve empty form values to catalog defaults so install can succeed with sensible config.json defaults. */
export const resolveFieldValue = (field: FormField, value: unknown): unknown => {
  if (value !== undefined && value !== null && value !== '') {
    return value;
  }
  if (field.default !== undefined && field.default !== null && String(field.default) !== '') {
    return field.default;
  }
  return value;
};

export const isOptionalFieldEmpty = (field: FormField, value: unknown): boolean => {
  if (field.required) return false;
  if (typeof value === 'boolean') return false;
  return value === undefined || value === null || value === '';
};

/** Merge catalog defaults into a flat form-values map (env_variable keys). */
export const mergeFormFieldDefaults = (values: Record<string, unknown>, fields: FormField[]): Record<string, unknown> => {
  const merged = { ...values };
  for (const field of fields) {
    if (HIDDEN_FIELD_TYPES.includes(field.type as (typeof HIDDEN_FIELD_TYPES)[number])) continue;
    if (field.default === undefined || field.default === null || String(field.default) === '') continue;
    const current = merged[field.env_variable];
    if (current === undefined || current === null || current === '') {
      merged[field.env_variable] = field.default;
    }
  }
  return merged;
};

export const validateField = (field: FormField, value: unknown): FormFieldValidationError | undefined => {
  if (isOptionalFieldEmpty(field, value)) {
    return undefined;
  }

  const resolved = resolveFieldValue(field, value);

  if (field.required && !resolved && typeof resolved !== 'boolean') {
    return {
      env_variable: field.env_variable,
      label: field.label,
      messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED',
      params: { label: field.label },
    };
  }

  if (isOptionalFieldEmpty(field, value)) {
    return undefined;
  }

  if (!resolved || typeof resolved !== 'string') {
    return undefined;
  }

  const stringValue = resolved;

  if (field.regex && !validator.matches(stringValue, field.regex)) {
    return {
      env_variable: field.env_variable,
      label: field.label,
      messageKey: field.pattern_error ?? 'APP_INSTALL_FORM_ERROR_REGEX',
      params: { label: field.label, pattern: field.regex },
    };
  }

  switch (field.type) {
    case 'text':
      if (field.max && stringValue.length > field.max) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_MAX_LENGTH',
          params: { label: field.label, max: String(field.max) },
        };
      }
      if (field.min && stringValue.length < field.min) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_MIN_LENGTH',
          params: { label: field.label, min: String(field.min) },
        };
      }
      break;
    case 'password': {
      const min = field.min || 0;
      const max = field.max ?? 4096;
      if (!validator.isLength(stringValue, { min, max })) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_BETWEEN_LENGTH',
          params: { label: field.label, min: String(min), max: String(max) },
        };
      }
      break;
    }
    case 'email':
      if (!validator.isEmail(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_INVALID_EMAIL',
          params: { label: field.label },
        };
      }
      break;
    case 'number':
      if (!validator.isNumeric(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_NUMBER',
          params: { label: field.label },
        };
      }
      break;
    case 'fqdn':
      if (!validator.isFQDN(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_FQDN',
          params: { label: field.label },
        };
      }
      break;
    case 'ip':
      if (!validator.isIP(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_IP',
          params: { label: field.label },
        };
      }
      break;
    case 'fqdnip':
      if (!validator.isFQDN(stringValue || '') && !validator.isIP(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_FQDNIP',
          params: { label: field.label },
        };
      }
      break;
    case 'url':
      if (!isGenericUrl(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_URL',
          params: { label: field.label },
        };
      }
      break;
    case 'app_base_url':
      if (!isAppBaseUrl(stringValue)) {
        return {
          env_variable: field.env_variable,
          label: field.label,
          messageKey: 'APP_INSTALL_FORM_ERROR_URL',
          params: { label: field.label },
        };
      }
      break;
    default:
      break;
  }

  return undefined;
};

const validateDomain = (domain?: unknown): FormFieldValidationError | undefined => {
  if (typeof domain !== 'string' || !validator.isFQDN(domain || '')) {
    return {
      env_variable: 'domain',
      label: String(domain),
      messageKey: 'APP_INSTALL_FORM_ERROR_FQDN',
      params: { label: String(domain) },
    };
  }
  return undefined;
};

const validateLocalSubdomain = (subdomain?: unknown): FormFieldValidationError | undefined => {
  if (!subdomain) {
    return {
      env_variable: 'localSubdomain',
      label: 'localSubdomain',
      messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED',
      params: { label: 'localSubdomain' },
    };
  }
  if (typeof subdomain !== 'string') {
    return {
      env_variable: 'localSubdomain',
      label: 'localSubdomain',
      messageKey: 'APP_INSTALL_FORM_ERROR_LOCAL_SUBDOMAIN_INVALID',
    };
  }
  if (!validator.matches(subdomain, /^[a-zA-Z0-9-]{1,63}$/)) {
    return {
      env_variable: 'localSubdomain',
      label: 'localSubdomain',
      messageKey: 'APP_INSTALL_FORM_ERROR_LOCAL_SUBDOMAIN_FORMAT',
    };
  }
  return undefined;
};

export type ValidateAppFormOptions = {
  /** When true and exposedLocal, require port (production cloudflare publish). */
  requirePortWhenExposedLocal?: boolean;
};

export const validateAppFormFields = (
  values: Record<string, unknown>,
  fields: FormField[],
  options: ValidateAppFormOptions = {},
): FormFieldValidationError[] => {
  const merged = mergeFormFieldDefaults(values, fields);
  const { exposed, exposedLocal, openPort, domain, localSubdomain, port, ...config } = merged;

  const errors: FormFieldValidationError[] = [];

  for (const field of fields.filter((f) => !HIDDEN_FIELD_TYPES.includes(f.type as (typeof HIDDEN_FIELD_TYPES)[number]))) {
    const error = validateField(field, config[field.env_variable]);
    if (error) errors.push(error);
  }

  if (exposed) {
    const error = validateDomain(domain);
    if (error) errors.push(error);
  }

  if (exposedLocal) {
    const error = validateLocalSubdomain(localSubdomain);
    if (error) errors.push(error);
    if (options.requirePortWhenExposedLocal && !port) {
      errors.push({
        env_variable: 'port',
        label: 'port',
        messageKey: 'APP_INSTALL_FORM_ERROR_REQUIRED',
        params: { label: 'port' },
      });
    }
  }

  if (openPort && port && !validator.isPort(String(port))) {
    errors.push({
      env_variable: 'port',
      label: 'port',
      messageKey: 'APP_INSTALL_FORM_ERROR_PORT',
      params: { port: String(port) },
    });
  }

  return errors;
};

export const isAppFormValid = (values: Record<string, unknown>, fields: FormField[], options?: ValidateAppFormOptions): boolean =>
  validateAppFormFields(values, fields, options).length === 0;
