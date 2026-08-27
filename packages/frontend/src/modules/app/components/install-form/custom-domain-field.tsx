import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import type { AvailableCustomDomainsResponseDto } from '@/api-client';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { Controller } from 'react-hook-form';

type AvailableCustomDomain = AvailableCustomDomainsResponseDto['domains'][number];

/**
 * The select's value for "no custom domain".
 *
 * A radix Select cannot hold `''` as an item value, and the API's own "clear it"
 * signal IS the empty string — so the two are kept apart here and converted at
 * the edge, rather than letting a UI constraint decide a wire contract.
 */
const PLATFORM_ADDRESS = '__platform__';

interface CustomDomainFieldProps<TFormValues extends FieldValues> {
  control: Control<TFormValues>;
  domains: AvailableCustomDomain[];
  /**
   * Whether CI-Cloud could be ASKED. False means an older CI-Cloud, or one that
   * did not answer — not "the organization has none".
   */
  supported: boolean;
  /** The platform hostname this app gets regardless — what the domain aliases. */
  platformHostname?: string;
  loading?: boolean;
  t: (key: string) => string;
}

/**
 * Pick one of the organization's connected custom domains for this app.
 *
 * ── WHAT THIS FIELD IS AND IS NOT ────────────────────────────────────────────
 *
 * It is ADDITIVE. The app still gets its platform hostname — that is the name
 * the custom domain aliases, and the one the tunnel actually routes — so this
 * does not replace the subdomain field above it. Choosing a domain records a
 * request, which the Hub asks CI-Cloud to honour once the app has registered;
 * the app is told about the hostname only after CI-Cloud confirms it is wired.
 *
 * ── WHY DOMAINS THAT CANNOT BE CHOSEN ARE STILL LISTED ───────────────────────
 *
 * A domain connected ten minutes ago and still verifying is the single most
 * likely thing a person is looking for here. Omitting it reads as "the Hub
 * cannot see my domain" — the exact silence this feature exists to end — so it
 * is shown, disabled, saying what it is waiting for.
 */
export function CustomDomainField<TFormValues extends FieldValues>({
  control,
  domains,
  supported,
  platformHostname,
  loading,
  t,
}: CustomDomainFieldProps<TFormValues>) {
  /*
   * ⚠ RENDERS NOTHING WHEN THERE IS NOTHING TO SAY. An organization with no
   * custom domains — and every deployment whose CI-Cloud predates them — must not
   * be shown an empty dropdown advertising a feature it is not using. The place
   * that teaches people custom domains exist is the portal, where they can
   * actually connect one.
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

          return (
            <>
              <label className="mb-1.5 block text-sm font-medium" htmlFor="install-custom-domain">
                {t('APP_INSTALL_FORM_CUSTOM_DOMAIN')}
              </label>
              <Select
                value={selected}
                disabled={loading}
                // `''`, never `undefined`: absent means "the caller said nothing",
                // which deliberately leaves an existing choice alone, while the
                // empty string is the instruction to go back to the platform name.
                onValueChange={(next) => onChange(next === PLATFORM_ADDRESS ? '' : next)}
              >
                <SelectTrigger id="install-custom-domain" aria-label={t('APP_INSTALL_FORM_CUSTOM_DOMAIN')} className="h-11">
                  <SelectValue placeholder={t('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PLATFORM_ADDRESS}>{t('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE')}</SelectItem>
                  {domains.map((entry) => (
                    <SelectItem key={entry.id} value={entry.domain} disabled={!entry.bindable}>
                      {entry.domain}
                      {entry.state === 'pending' ? ` — ${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_VERIFYING')}` : null}
                      {/*
                       * Named, so moving a live domain is a decision rather than
                       * a surprise: choosing it here takes it off whatever it is
                       * serving now, and the person doing it is entitled to know
                       * that before they click rather than after.
                       */}
                      {entry.state === 'live' && entry.boundAppSlug ? ` — ${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE')} ${entry.boundAppSlug}` : null}
                      {entry.state === 'live' && !entry.boundAppSlug && entry.boundElsewhere
                        ? ` — ${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE_ELSEWHERE')}`
                        : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {selected === PLATFORM_ADDRESS
                  ? t('APP_INSTALL_FORM_CUSTOM_DOMAIN_HINT')
                  : /*
                     * Says the restart out loud. The env vars an app builds its
                     * OAuth redirects from are written when its container is
                     * created, so a binding that arrives afterwards cannot reach
                     * a running app without one — and being asked for a restart
                     * you were not warned about reads as a bug.
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
