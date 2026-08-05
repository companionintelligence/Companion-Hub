import type { FormField } from '@/types/app.types';
import {
  HIDDEN_FIELD_TYPES,
  isAppFormValid,
  mergeFormFieldDefaults,
  resolveFieldValue,
  validateAppFormFields,
  validateField as sharedValidateField,
  type ValidateAppFormOptions,
} from '@ci-hub/common/validation';

type ValidationError = {
  messageKey: string;
  params?: Record<string, string>;
};

export const hiddenTypes = [...HIDDEN_FIELD_TYPES];

export { mergeFormFieldDefaults, resolveFieldValue };

export const validateField = (field: FormField, value: unknown): ValidationError | undefined => {
  const error = sharedValidateField(field, value);
  if (!error) return undefined;
  return { messageKey: error.messageKey, params: error.params };
};

export const validateAppConfig = (values: Record<string, unknown>, fields: FormField[], options?: ValidateAppFormOptions) => {
  const errors: Record<string, ValidationError | undefined> = {};
  for (const error of validateAppFormFields(values, fields, options)) {
    errors[error.env_variable] = { messageKey: error.messageKey, params: error.params };
  }
  return errors;
};

/** Same checks as submit validation — use for the install button validity gate. */
export const isInstallFormValid = (values: Record<string, unknown>, fields: FormField[], options?: ValidateAppFormOptions): boolean =>
  isAppFormValid(values, fields, options);
