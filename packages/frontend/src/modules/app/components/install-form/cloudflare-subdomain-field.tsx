import { InputGroup } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import type { AvailableDomain } from '@ci-hub/common/types';
import type { Control, FieldValues, Path, UseFormRegister } from 'react-hook-form';
import { Controller } from 'react-hook-form';

interface CloudflareSubdomainFieldProps<TFormValues extends FieldValues> {
  control: Control<TFormValues>;
  availableDomains: AvailableDomain[];
  watchPublicDomain?: string;
  domain?: string;
  cloudflareSuffix: string;
  register: UseFormRegister<TFormValues>;
  loading?: boolean;
  localSubdomainError?: string;
  placeholder: string;
  isCheckingDns: boolean;
  t: (key: string) => string;
}

export function CloudflareSubdomainField<TFormValues extends FieldValues>({
  control,
  availableDomains,
  watchPublicDomain,
  domain,
  cloudflareSuffix,
  register,
  loading,
  localSubdomainError,
  placeholder,
  isCheckingDns,
  t,
}: CloudflareSubdomainFieldProps<TFormValues>) {
  return (
    <div className="mb-3">
      <InputGroup
        groupPrefix="https://"
        groupClassName="overflow-hidden"
        groupSuffixClassName="shrink min-w-0 max-w-[55%] flex-1 basis-0 overflow-hidden items-stretch"
        groupSuffix={
          availableDomains.length > 0 ? (
            <Controller
              control={control}
              name={'publicDomain' as Path<TFormValues>}
              render={({ field: { onChange, value } }) => {
                const prefixText = `-${cloudflareSuffix}.`;
                const selectedDomain = (value as string) || watchPublicDomain || domain || '';

                return (
                  <div className="flex h-11 w-full min-w-0 overflow-hidden items-stretch rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground">
                    <div title={prefixText} className="flex min-w-0 max-w-[52%] shrink-0 items-center px-3 overflow-hidden">
                      <span className="block w-full min-w-0 truncate">{prefixText}</span>
                    </div>
                    <Select value={(value as string) || ''} onValueChange={onChange}>
                      <SelectTrigger
                        title={selectedDomain}
                        aria-label={t('COMMON_PUBLIC_DOMAIN')}
                        className="h-11 min-w-0 w-0 flex-1 basis-0 rounded-r-md rounded-l-none border-0 bg-muted px-3 text-sm text-foreground shadow-none focus:ring-0 overflow-hidden gap-2 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate [&>span]:text-left [&>svg]:shrink-0"
                      >
                        <SelectValue placeholder={t('COMMON_PUBLIC_DOMAIN')} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableDomains.map((entry) => (
                          <SelectItem key={entry.id} value={entry.domain}>
                            {entry.domain}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              }}
            />
          ) : (
            `-${cloudflareSuffix}.${watchPublicDomain || domain}`
          )
        }
        {...register('localSubdomain' as Path<TFormValues>)}
        label={t('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')}
        error={localSubdomainError}
        disabled={loading}
        placeholder={placeholder}
      />
      <div className="mt-1.5 min-h-5 pr-3">
        {isCheckingDns ? <p className="text-sm text-muted-foreground">{t('APP_INSTALL_FORM_CHECKING_DNS')}</p> : null}
      </div>
    </div>
  );
}
