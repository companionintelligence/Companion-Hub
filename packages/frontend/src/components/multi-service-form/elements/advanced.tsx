import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import type { UseFormRegister, Control, FieldErrors } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { useTranslation } from 'react-i18next';

type FormData = z.infer<typeof dynamicComposeSchema>;

type Props = {
  register: UseFormRegister<FormData>;
  control: Control<FormData>;
  serviceIndex: number;
  errors?: FieldErrors<FormData>;
};

export const AdvancedConfig = ({ register, errors, control, serviceIndex }: Props) => {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Input
          {...register(`services.${serviceIndex}.networkMode`, { setValueAs: (v) => v.trim() || undefined })}
          error={errors?.services?.[serviceIndex]?.networkMode?.message}
          label={
            <>
              {t('MULTI_SERVICE_ADVANCED_NETWORK_MODE')}{' '}
              <HintMarker anchorClass="my-network-mode" hint={t('MULTI_SERVICE_ADVANCED_NETWORK_MODE_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ADVANCED_NETWORK_MODE_PLACEHOLDER')}
        />
      </div>
      <div>
        <Input
          {...register(`services.${serviceIndex}.workingDir`, { setValueAs: (v) => v || undefined })}
          error={errors?.services?.[serviceIndex]?.workingDir?.message}
          label={
            <>
              {t('MULTI_SERVICE_ADVANCED_WORKING_DIR')}{' '}
              <HintMarker anchorClass="my-working-dir" hint={t('MULTI_SERVICE_ADVANCED_WORKING_DIR_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ADVANCED_WORKING_DIR_PLACEHOLDER')}
        />
      </div>
      <div>
        <Input
          {...register(`services.${serviceIndex}.user`, { setValueAs: (v) => v.trim() || undefined })}
          error={errors?.services?.[serviceIndex]?.user?.message}
          label={
            <>
              {t('MULTI_SERVICE_ADVANCED_USER')} <HintMarker anchorClass="my-user" hint={t('MULTI_SERVICE_ADVANCED_USER_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ADVANCED_USER_PLACEHOLDER')}
        />
      </div>
      <div>
        <Input
          {...register(`services.${serviceIndex}.hostname`, { setValueAs: (v) => v.trim() || undefined })}
          error={errors?.services?.[serviceIndex]?.hostname?.message}
          label={
            <>
              {t('COMMON_HOSTNAME')} <HintMarker anchorClass="my-hostname" hint={t('MULTI_SERVICE_ADVANCED_HOSTNAME_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ADVANCED_HOSTNAME_PLACEHOLDER')}
        />
      </div>
      <div>
        <Controller
          control={control}
          name={`services.${serviceIndex}.privileged`}
          defaultValue={false}
          render={({ field: { onChange, value, ref, ...rest } }) => (
            <Switch
              ref={ref}
              checked={value}
              onCheckedChange={onChange}
              {...rest}
              label={
                <>
                  {t('MULTI_SERVICE_ADVANCED_PRIVILEGED_MODE')}{' '}
                  <HintMarker anchorClass="my-privileged" hint={t('MULTI_SERVICE_ADVANCED_PRIVILEGED_MODE_TOOLTIP')} />
                </>
              }
            />
          )}
        />
      </div>
    </div>
  );
};
