import { Input } from '@/components/ui/Input';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { useTranslation } from 'react-i18next';

type Props = {
  register: UseFormRegister<z.infer<typeof dynamicComposeSchema>>;
  serviceIndex: number;
  errors?: FieldErrors<z.infer<typeof dynamicComposeSchema>>;
};

export const EssentialConfig = ({ register, errors, serviceIndex }: Props) => {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <Input
          {...register(`services.${serviceIndex}.name`, { setValueAs: (v) => v.trim() || undefined })}
          error={t(errors?.services?.[serviceIndex]?.name?.message as string)}
          label={
            <>
              {t('MULTI_SERVICE_ESSENTIALS_SERVICE_NAME')}{' '}
              <HintMarker anchorClass="my-service" hint={t('MULTI_SERVICE_ESSENTIALS_SERVICE_NAME_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ESSENTIALS_SERVICE_NAME_PLACEHOLDER')}
        />
      </div>
      <div>
        <Input
          {...register(`services.${serviceIndex}.image`, { setValueAs: (v) => v.trim() || undefined })}
          error={t(errors?.services?.[serviceIndex]?.image?.message as string)}
          label={
            <>
              {t('COMMON_IMAGE')} <HintMarker anchorClass="my-image" hint={t('MULTI_SERVICE_ESSENTIALS_IMAGE_TOOLTIP')} />
            </>
          }
          placeholder={t('MULTI_SERVICE_ESSENTIALS_IMAGE_PLACEHOLDER')}
        />
      </div>
      <div>
        <Input
          {...register(`services.${serviceIndex}.internalPort`)}
          error={t(errors?.services?.[serviceIndex]?.internalPort?.message as string)}
          label={
            <>
              {t('MULTI_SERVICE_ESSENTIALS_INTERNAL_PORT')}{' '}
              <HintMarker anchorClass="my-internal-port" hint={t('MULTI_SERVICE_ESSENTIALS_INTERNAL_PORT_TOOLTIP')} />
            </>
          }
          placeholder="9091"
        />
      </div>
    </div>
  );
};
