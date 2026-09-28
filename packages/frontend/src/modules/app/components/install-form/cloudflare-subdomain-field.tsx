import { InputGroup } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { cn } from '@/lib/utils';
import type { AvailableDomain } from '@ci-hub/common/types';
import { Info, Loader2, RefreshCw } from 'lucide-react';
import { useId } from 'react';
import type { Control, FieldValues, Path, UseFormRegister } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import { Tooltip } from 'react-tooltip';
import type { DomainListNote } from './domain-list-note';

const DOMAIN_LIST_NOTE_KEYS = {
  loading: 'APP_INSTALL_FORM_DOMAINS_LOADING',
  unavailable: 'APP_INSTALL_FORM_DOMAINS_UNAVAILABLE',
  'none-offered': 'APP_INSTALL_FORM_DOMAINS_NONE_OFFERED',
} as const;

interface CloudflareSubdomainFieldProps<TFormValues extends FieldValues> {
  control: Control<TFormValues>;
  availableDomains: AvailableDomain[];
  watchPublicDomain?: string;
  domain?: string;
  cloudflareSuffix: string;
  register: UseFormRegister<TFormValues>;
  loading?: boolean;
  localSubdomainError?: string;
  publicDomainError?: string;
  placeholder: string;
  isCheckingDns: boolean;
  /** Why the domain is plain text rather than a picker. See `domainListNoteFor`. */
  domainListNote: DomainListNote;
  /** Asks for the domain list again. Offered when it could not be loaded. */
  onRetryDomainList: () => void;
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
  publicDomainError,
  placeholder,
  isCheckingDns,
  domainListNote,
  onRetryDomainList,
  t,
}: CloudflareSubdomainFieldProps<TFormValues>) {
  // react-tooltip finds its anchor by selector, and `useId` returns colons.
  const noteAnchorClass = `domain-list-note-${useId().replace(/[^\w-]/g, '')}`;
  const showNote = availableDomains.length === 0 && domainListNote !== undefined;
  const noteHint = domainListNote ? t(DOMAIN_LIST_NOTE_KEYS[domainListNote]) : undefined;

  return (
    <div className="mb-3">
      {/*
       * Outside the suffix, whose `overflow-hidden` keeps a long domain on one
       * line: the tooltip must not be clipped by it.
       */}
      {showNote ? <Tooltip className="tooltip" anchorSelect={`.${noteAnchorClass}`} place="top-end" content={noteHint} /> : null}
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
                  <div className="flex h-9 w-full min-w-0 overflow-hidden items-stretch rounded-r-md border border-l-0 border-input bg-muted text-sm text-muted-foreground">
                    <div title={prefixText} className="flex min-w-0 max-w-[52%] shrink-0 items-center px-3 overflow-hidden">
                      <span className="block w-full min-w-0 truncate">{prefixText}</span>
                    </div>
                    {/*
                     * ⚠ AN EMPTY VALUE IS NEVER A CHOICE. Radix's hidden native
                     * select answers a value the form sets (the Portal's
                     * preselection) with a change to `''` before its options have
                     * caught up, which cleared the picker to its placeholder while
                     * the form kept the domain. No item has an empty value, so no
                     * person can pick one.
                     */}
                    <Select
                      value={(value as string) || ''}
                      onValueChange={(next) => {
                        if (next) {
                          onChange(next);
                        }
                      }}
                    >
                      <SelectTrigger
                        title={selectedDomain}
                        aria-label={t('COMMON_PUBLIC_DOMAIN')}
                        className="h-9 min-w-0 w-0 flex-1 basis-0 rounded-r-md rounded-l-none border-0 bg-muted px-3 text-sm text-foreground shadow-none focus:ring-0 overflow-hidden gap-2 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate [&>span]:text-left [&>svg]:shrink-0"
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
            <PlainDomainSuffix
              text={`-${cloudflareSuffix}.${watchPublicDomain || domain}`}
              note={domainListNote}
              hint={noteHint}
              anchorClass={noteAnchorClass}
              onRetry={onRetryDomainList}
            />
          )
        }
        {...register('localSubdomain' as Path<TFormValues>)}
        label={t('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')}
        error={localSubdomainError}
        disabled={loading}
        placeholder={placeholder}
      />
      {publicDomainError ? <p className="mt-1.5 text-sm text-destructive">{publicDomainError}</p> : null}
      <div className="mt-1.5 min-h-5 pr-3">
        {isCheckingDns ? <p className="text-sm text-muted-foreground">{t('APP_INSTALL_FORM_CHECKING_DNS')}</p> : null}
      </div>
    </div>
  );
}

interface PlainDomainSuffixProps {
  text: string;
  note: DomainListNote;
  hint?: string;
  anchorClass: string;
  onRetry: () => void;
}

/**
 * The domain as plain text, with a mark saying why there is no picker.
 *
 * Without the mark, a list still loading, a list that failed and a Portal that
 * offers nothing all look the same, and the form reads as though it never had a
 * picker. The mark carries the explanation as its tooltip and accessible name.
 */
function PlainDomainSuffix({ text, note, hint, anchorClass, onRetry }: PlainDomainSuffixProps) {
  return (
    <div className="flex h-9 w-full min-w-0 items-center gap-2 overflow-hidden rounded-r-md border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground">
      <span title={text} className="block min-w-0 flex-1 truncate">
        {text}
      </span>
      {note === 'loading' ? (
        <span role="status" aria-label={hint} className={cn('flex shrink-0 cursor-help', anchorClass)} data-testid="domain-list-loading">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        </span>
      ) : null}
      {note === 'unavailable' ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={hint}
          className={cn(
            'flex shrink-0 rounded-sm text-warning transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            anchorClass,
          )}
          data-testid="domain-list-retry"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {note === 'none-offered' ? (
        <span role="img" aria-label={hint} className={cn('flex shrink-0 cursor-help', anchorClass)} data-testid="domain-list-none-offered">
          <Info className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </div>
  );
}
