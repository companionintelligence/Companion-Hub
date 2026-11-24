import { Switch } from '@/components/ui/Switch';
import './elements.css';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import { Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { Controller, useFieldArray, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { useTranslation } from 'react-i18next';

type Props = {
  control: Control<z.infer<typeof dynamicComposeSchema>>;
  register: UseFormRegister<z.infer<typeof dynamicComposeSchema>>;
  serviceIndex: number;
  errors?: FieldErrors<z.infer<typeof dynamicComposeSchema>>;
};

export const VolumesConfig = ({ errors, serviceIndex, control, register }: Props) => {
  const { t } = useTranslation();
  const { fields, append, remove } = useFieldArray({
    control,
    name: `services.${serviceIndex}.volumes`,
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            {t('MULTI_SERVICE_VOLUMES_TITLE')} <HintMarker anchorClass="my-volumes" hint={t('MULTI_SERVICE_VOLUMES_TITLE_TOOLTIP')} />
          </div>
          <Button type="button" onClick={() => append({ containerPath: '/', hostPath: '/' })} size="sm" variant="outline" className="gap-1.5">
            <Plus className="size-4" aria-hidden="true" />
            {t('MULTI_SERVICE_VOLUMES_ADD_VOLUME')}
          </Button>
        </div>
        <Table className={clsx('border p-1', { hidden: fields.length === 0 })}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('MULTI_SERVICE_VOLUMES_HOST_PATH')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_VOLUMES_CONTAINER_PATH')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_VOLUMES_READ_ONLY')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_VOLUMES_SHARED')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_VOLUMES_PRIVATE')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => (
              <TableRow key={field.id}>
                <TableCell scope="row" className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.volumes.${index}.hostPath`, { setValueAs: (v) => v.trim() || undefined })}
                    error={t(errors?.services?.[serviceIndex]?.volumes?.[index]?.hostPath?.message as string)}
                    placeholder="/host/path"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.volumes.${index}.containerPath`, { setValueAs: (v) => v.trim() || undefined })}
                    error={t(errors?.services?.[serviceIndex]?.volumes?.[index]?.containerPath?.message as string)}
                    placeholder="/container/path"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-10">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.volumes.${index}.readOnly`}
                    defaultValue={false}
                    render={({ field: { value, onChange } }) => (
                      <Switch aria-label={t('MULTI_SERVICE_VOLUMES_READ_ONLY')} checked={value || false} onCheckedChange={onChange} />
                    )}
                  />
                </TableCell>
                <TableCell className="w-10">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.volumes.${index}.shared`}
                    defaultValue={false}
                    render={({ field: { value, onChange } }) => (
                      <Switch aria-label={t('MULTI_SERVICE_VOLUMES_SHARED')} checked={value || false} onCheckedChange={onChange} />
                    )}
                  />
                </TableCell>
                <TableCell className="w-10">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.volumes.${index}.private`}
                    defaultValue={false}
                    render={({ field: { value, onChange } }) => (
                      <Switch aria-label={t('MULTI_SERVICE_VOLUMES_PRIVATE')} checked={value || false} onCheckedChange={onChange} />
                    )}
                  />
                </TableCell>
                <TableCell className="w-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={t('COMMON_REMOVE')} onClick={() => remove(index)}>
                    <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {fields.length === 0 && <div className="text-sm text-muted-foreground">{t('MULTI_SERVICE_VOLUMES_NO_VOLUMES')}</div>}
      </div>
    </div>
  );
};
