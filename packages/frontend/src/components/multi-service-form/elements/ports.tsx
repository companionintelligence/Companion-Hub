import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import './elements.css';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { dynamicComposeSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import { X } from 'lucide-react';
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

export const PortsConfig = ({ errors, serviceIndex, control, register }: Props) => {
  const { t } = useTranslation();
  const { fields, append, remove } = useFieldArray({
    control,
    name: `services.${serviceIndex}.addPorts`,
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            {t('MULTI_SERVICE_PORTS_TITLE')} <HintMarker anchorClass="my-ports" hint={t('MULTI_SERVICE_PORTS_TITLE_TOOLTIP')} />
          </div>
          <Button type="button" onClick={() => append({ containerPort: 9091, hostPort: 9091 })} size="sm">
            {t('MULTI_SERVICE_PORTS_ADD_PORT')}
          </Button>
        </div>
        <Table className={clsx('border p-1', { hidden: fields.length === 0 })}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('COMMON_HOST_PORT')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_CONTAINER_PORT')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_TCP')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_UDP')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_INTERFACE')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => (
              <TableRow key={field.id}>
                <TableCell scope="row" className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.hostPort`)}
                    error={t(errors?.services?.[serviceIndex]?.addPorts?.[index]?.hostPort?.message as string)}
                    placeholder="9091"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.containerPort`)}
                    error={t(errors?.services?.[serviceIndex]?.addPorts?.[index]?.containerPort?.message as string)}
                    placeholder="9091"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-10">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.addPorts.${index}.tcp`}
                    defaultValue={true}
                    render={({ field: { onChange, value, ref, ...rest } }) => (
                      <Checkbox ref={ref} checked={value} onCheckedChange={onChange} {...rest} className="mb-0" />
                    )}
                  />
                </TableCell>
                <TableCell className="w-10">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.addPorts.${index}.udp`}
                    defaultValue={true}
                    render={({ field: { onChange, value, ref, ...rest } }) => (
                      <Checkbox ref={ref} checked={value} onCheckedChange={onChange} {...rest} className="mb-0" />
                    )}
                  />
                </TableCell>
                <TableCell className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.interface`, { setValueAs: (v) => v.trim() || undefined })}
                    error={errors?.services?.[serviceIndex]?.addPorts?.[index]?.interface?.message}
                    placeholder={t('MULTI_SERVICE_PORTS_INTERFACE_PLACEHOLDER')}
                  />
                </TableCell>
                <TableCell className="w-1">
                  <Button type="button" size="sm" onClick={() => remove(index)} className="btn-action">
                    <X size={16} />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {fields.length === 0 && <div className="text-sm text-muted-foreground">{t('MULTI_SERVICE_PORTS_NO_PORTS')}</div>}
      </div>
    </div>
  );
};
