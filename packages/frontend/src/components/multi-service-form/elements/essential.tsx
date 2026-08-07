import { Input } from '@/components/ui/Input';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Tooltip } from 'react-tooltip';
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
              <Tooltip className="tooltip" anchorSelect=".my-service">
                {t('MULTI_SERVICE_ESSENTIALS_SERVICE_NAME_TOOLTIP')}
              </Tooltip>
              {t('MULTI_SERVICE_ESSENTIALS_SERVICE_NAME')} <span className="ms-1 form-help my-service">?</span>
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
              <Tooltip className="tooltip" anchorSelect=".my-image">
                {t('MULTI_SERVICE_ESSENTIALS_IMAGE_TOOLTIP')}
              </Tooltip>
              {t('COMMON_IMAGE')} <span className="ms-1 form-help my-image">?</span>
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
              <Tooltip className="tooltip" anchorSelect=".my-internal-port">
                {t('MULTI_SERVICE_ESSENTIALS_INTERNAL_PORT_TOOLTIP')}
              </Tooltip>
              {t('MULTI_SERVICE_ESSENTIALS_INTERNAL_PORT')} <span className="ms-1 form-help my-internal-port">?</span>
            </>
          }
          placeholder="9091"
        />
      </div>
    </div>
  );
};
