import { Button } from '@/components/ui/Button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import type { AvailableCustomDomainsResponseDto } from '@/api-client';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { useState } from 'react';
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
  /*
   * ⚠ `failed` IS BINDABLE, WHICH IS WHY IT HAS TO BE NAMED HERE.
   *
   * CI-Cloud reports a permanently failed certificate on the same terms as the
   * two states above and deliberately leaves `bindable` true. Unlike them it
   * never clears itself — there is no in-place reissue, only
   * disconnect-and-reconnect — so a build that had not heard of the state
   * parsed it as `unknown`, matched none of the conditions here, and rendered
   * the domain as an ordinary selectable option with NO note at all: a domain
   * that can never serve, offered silently. The row stays selectable, because
   * `bindable` is CI-Cloud's gate and not ours to override, but it says so.
   */
  if (entry.state === 'failed') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_FAILED');
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

/**
 * Would choosing this domain take it off something that is serving now?
 *
 * The same question the bind pass asks of `entry.targetHostname`, asked here of
 * what the listing can name — CI-Cloud reports `boundAppSlug` only for an app on
 * THIS device and sets `boundElsewhere` from `device_id`, so the two together
 * are the whole answer. A domain already serving the app being configured is not
 * a move.
 */
function isTakeover(entry: AvailableCustomDomain, currentAppSlug: string | undefined): boolean {
  if (entry.boundAppSlug) return entry.boundAppSlug !== currentAppSlug;

  return entry.boundElsewhere;
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
  /**
   * Records the operator's answer to the takeover question on the form.
   *
   * A separate field rather than something inferred from `customDomain` at save
   * time, because the answer is only knowable HERE: by the time the backend sees
   * the form it has no way to tell whether anybody was shown the warning, and
   * the bind pass that acts on it runs long after this dialog is closed.
   */
  onTakeoverChange: (confirmed: boolean) => void;
  loading?: boolean;
  t: (key: string, values?: Record<string, string>) => string;
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
  onTakeoverChange,
  loading,
  t,
}: CustomDomainFieldProps<TFormValues>) {
  /*
   * The domain the operator has picked but not yet confirmed moving.
   *
   * ⚠ HELD HERE RATHER THAN WRITTEN TO THE FORM. A two-step choice must not
   * leave the form in a state that could be submitted between the steps: writing
   * `customDomain` first and the confirmation second means a save landing in
   * that window records the move with no answer attached, which the bind pass
   * would read as a refusal — the operator's choice silently dropped. Nothing
   * reaches the form until they answer.
   */
  const [pendingTakeover, setPendingTakeover] = useState<AvailableCustomDomain | null>(null);

  /*
   * The domain this app is actually SERVING, taken from CI-Cloud's own listing
   * rather than from a local mirror of it.
   *
   * `boundAppSlug` is only ever set for an app on this device, so a row naming
   * this app is CI-Cloud saying it delivers that hostname here — which is the
   * only state a release can act on, and the only one where clearing the picker
   * is irreversible. Derived rather than passed in because the answer has to be
   * CI-Cloud's: `app.custom_domain` is a copy of it that goes stale between
   * syncs, and a stale copy would either hide the warning or show it for a
   * domain that has already gone.
   */
  const servingDomain = domains.find((entry) => entry.boundAppSlug && entry.boundAppSlug === currentAppSlug)?.domain ?? null;
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
                onValueChange={(next) => {
                  if (next === PLATFORM_ADDRESS) {
                    setPendingTakeover(null);
                    onTakeoverChange(false);
                    onChange('');

                    return;
                  }

                  const entry = domains.find((candidate) => candidate.domain === next);

                  /*
                   * Ask before moving, and commit nothing until it is answered.
                   * Without this the bind pass would take a domain off whatever
                   * is serving it — possibly a production hostname on another Hub
                   * in the organization — from a background heartbeat, with no
                   * confirmation anywhere (CI-Engineering#208, defect 4).
                   */
                  if (entry && isTakeover(entry, currentAppSlug)) {
                    setPendingTakeover(entry);

                    return;
                  }

                  setPendingTakeover(null);
                  onTakeoverChange(false);
                  onChange(next);
                }}
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
              {pendingTakeover ? (
                <div
                  className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400"
                  data-testid="custom-domain-takeover-confirm"
                >
                  <p className="mb-1 font-medium">{t('APP_INSTALL_FORM_CUSTOM_DOMAIN_TAKEOVER_TITLE')}</p>
                  <p className="mb-2">
                    {pendingTakeover.boundAppSlug
                      ? t('APP_INSTALL_FORM_CUSTOM_DOMAIN_TAKEOVER_BODY', {
                          domain: pendingTakeover.domain,
                          target: pendingTakeover.boundAppSlug,
                        })
                      : t('APP_INSTALL_FORM_CUSTOM_DOMAIN_TAKEOVER_BODY_ELSEWHERE', { domain: pendingTakeover.domain })}
                  </p>
                  <div className="flex gap-2">
                    {/* `type="button"`: this sits inside the config form, and a bare
                        button would submit it. */}
                    <Button
                      type="button"
                      size="sm"
                      intent="warning"
                      data-testid="custom-domain-takeover-accept"
                      onClick={() => {
                        onChange(pendingTakeover.domain);
                        onTakeoverChange(true);
                        setPendingTakeover(null);
                      }}
                    >
                      {t('APP_INSTALL_FORM_CUSTOM_DOMAIN_TAKEOVER_CONFIRM')}
                    </Button>
                    <Button type="button" size="sm" data-testid="custom-domain-takeover-cancel" onClick={() => setPendingTakeover(null)}>
                      {t('APP_INSTALL_FORM_CUSTOM_DOMAIN_TAKEOVER_CANCEL')}
                    </Button>
                  </div>
                </div>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {selected === PLATFORM_ADDRESS
                  ? /*
                     * ⚠ SAY THAT SAVING RELEASES IT, WHEN IT WILL. Clearing the
                     * picker for an app that is currently SERVING a domain is not
                     * a local preference: CI-Cloud cannot park a connected domain,
                     * so the save gives it up entirely and only a person in the
                     * portal can reconnect it. Offering that behind the same
                     * neutral sentence used when nothing is bound would be the
                     * one place this dialog hides an irreversible act.
                     */
                    servingDomain
                    ? t('APP_INSTALL_FORM_CUSTOM_DOMAIN_RELEASE_HINT')
                    : t('APP_INSTALL_FORM_CUSTOM_DOMAIN_HINT')
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
