import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import type { AvailableCustomDomainsResponseDto } from '@/api-client';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { Controller } from 'react-hook-form';

type AvailableCustomDomain = AvailableCustomDomainsResponseDto['domains'][number];

/**
 * Represents "no custom domain" inside the Select component.
 *
 * Radix Select does not allow an empty item value, while the API uses `''` to
 * clear a domain. Keep the UI sentinel separate and convert it at the API
 * boundary so the component constraint does not change the wire contract.
 */
const PLATFORM_ADDRESS = '__platform__';

/**
 * Returns the status shown beside a domain, or `null` when no status is useful.
 *
 * Centralizing the mutually exclusive states keeps bindable states such as
 * `parked` from disappearing through inconsistent JSX conditions.
 *
 * Compare `boundAppSlug` with `currentAppSlug` before displaying an in-use
 * warning. A domain already serving the app being configured is the expected
 * settings state and does not represent a transfer.
 */
function describeEntry(entry: AvailableCustomDomain, currentAppSlug: string | undefined, t: (key: string) => string): string | null {
  if (entry.state === 'pending') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_VERIFYING');
  if (entry.state === 'securing') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_SECURING');
  if (entry.state === 'drifted') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_DRIFTED');
  if (entry.state !== 'live') return null;
  /*
   * Name the current binding before selection because choosing this live domain
   * moves it away from the app or device it serves.
   */
  if (entry.boundAppSlug) {
    return entry.boundAppSlug === currentAppSlug ? null : `${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE')} ${entry.boundAppSlug}`;
  }
  if (entry.boundElsewhere) return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE_ELSEWHERE');
  return null;
}

interface CustomDomainFieldProps<TFormValues extends FieldValues> {
  control: Control<TFormValues>;
  domains: AvailableCustomDomain[];
  /**
   * Indicates whether Companion Portal could return an authoritative list.
   *
   * `false` represents an older or unavailable Portal, not an organization with
   * no domains.
   */
  supported: boolean;
  /** Identifies the platform hostname that the custom domain aliases. */
  platformHostname?: string;
  /**
   * Identifies the configured app by its Companion Portal `boundAppSlug`.
   *
   * Suppress the in-use warning when the domain already serves this app; no
   * transfer occurs in that case.
   */
  currentAppSlug?: string;
  loading?: boolean;
  t: (key: string) => string;
}

/**
 * Lets the user select a connected custom domain for an app.
 *
 * Additive behavior
 *
 * The app retains its platform hostname because the custom domain aliases that
 * routed identity. This field does not replace the subdomain field. Selection
 * records an intent that the Hub sends to Companion Portal after app
 * registration. The app receives the custom hostname only after the Portal
 * confirms the binding.
 *
 * Unavailable domains
 *
 * Keep connected domains visible while they are verifying. Users often open
 * this field to find a newly connected domain, so omitting it would imply that
 * the Hub cannot see it. Disable the option and display its current state.
 */
export function CustomDomainField<TFormValues extends FieldValues>({
  control,
  domains,
  supported,
  platformHostname,
  currentAppSlug,
  loading,
  t,
}: CustomDomainFieldProps<TFormValues>) {
  /*
   * Hide the field when no connected domains are available or the Portal cannot
   * list them. An empty dropdown would advertise an unusable feature; Companion
   * Portal is where users can connect a domain.
   */
  if (!supported || domains.length === 0) {
    return null;
  }

  return (
    <div className="mb-3">
      <Controller
        control={control}
        name={'customDomain' as Path<TFormValues>}
        render={({ field: { onChange, value } }) => {
          const selected = (value as string | undefined) || PLATFORM_ADDRESS;
          /*
           * Radix renders a blank trigger when the value matches no item; its
           * placeholder appears only for `''` or `undefined`. A disconnected
           * domain can remain selected until the Hub clears its intent. Represent
           * that value as a disabled item so the control explains the current
           * state instead of appearing empty.
           */
          const unlisted = selected !== PLATFORM_ADDRESS && !domains.some((entry) => entry.domain === selected);

          return (
            <>
              <Select
                value={selected}
                disabled={loading}
                // Send `''`, not `undefined`, because absence preserves the current
                // choice while an empty string restores the platform hostname.
                onValueChange={(next) => onChange(next === PLATFORM_ADDRESS ? '' : next)}
              >
                {/*
                 * Let `SelectTrigger` render the label so this field shares the
                 * dialog's markup and peer-disabled styling.
                 */}
                <SelectTrigger
                  id="install-custom-domain"
                  aria-label={t('APP_INSTALL_FORM_CUSTOM_DOMAIN')}
                  label={t('APP_INSTALL_FORM_CUSTOM_DOMAIN')}
                >
                  <SelectValue placeholder={t('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PLATFORM_ADDRESS}>{t('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE')}</SelectItem>
                  {unlisted ? (
                    <SelectItem value={selected} disabled note={t('APP_INSTALL_FORM_CUSTOM_DOMAIN_UNAVAILABLE')}>
                      {selected}
                    </SelectItem>
                  ) : null}
                  {domains.map((entry) => (
                    <SelectItem key={entry.id} value={entry.domain} disabled={!entry.bindable} note={describeEntry(entry, currentAppSlug, t)}>
                      {entry.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                {selected === PLATFORM_ADDRESS
                  ? t('APP_INSTALL_FORM_CUSTOM_DOMAIN_HINT')
                  : /*
                     * Warn about the restart because the app receives OAuth base
                     * URL variables when its container is created. A later domain
                     * binding cannot update a running container.
                     */
                    `${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_PENDING_HINT')}${platformHostname ? ` (${platformHostname})` : ''}`}
              </p>
            </>
          );
        }}
      />
    </div>
  );
}
