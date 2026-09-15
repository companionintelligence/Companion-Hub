import { Button } from '@/components/ui/Button';
import { customDomainHeldByAnotherHub, customDomainServesAnotherApp } from '@ci-hub/common/types';
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
 * The portal page where an owner or admin moves a domain between Hubs
 * (organization settings → domains), or `null` when this Hub has no portal
 * address to link to. `/api/portal/config` already trims the address and strips
 * its trailing slash.
 */
function portalDomainsUrl(portalUrl: string | null | undefined): string | null {
  return portalUrl ? `${portalUrl}/org-settings?tab=domains` : null;
}

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
  /*
   * ⚠ `failed` IS BINDABLE, WHICH IS WHY IT HAS TO BE NAMED HERE.
   *
   * CI-Cloud reports a permanently failed certificate on the same terms as
   * `securing` and `drifted` and deliberately leaves `bindable` true. Unlike
   * them it never clears itself — there is no in-place reissue, only
   * disconnect-and-reconnect — so a build that had not heard of the state
   * parsed it as `unknown`, matched none of the conditions here, and rendered
   * the domain as an ordinary selectable option with NO note at all: a domain
   * that can never serve, offered silently. The row stays selectable, because
   * `bindable` is CI-Cloud's gate and not ours to override, but it says so.
   *
   * First, even for a domain another Hub holds: moving it would not issue the
   * certificate, and reconnecting it fixes both.
   */
  if (entry.state === 'failed') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_FAILED');
  /*
   * Ahead of the other states, because it is the reason the option is
   * disabled: whatever else the domain is doing on that Hub, this one cannot
   * take it. A row still verifying never answers yes; see the predicate.
   */
  if (customDomainHeldByAnotherHub(entry)) return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_ON_ANOTHER_HUB');
  if (entry.state === 'pending') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_VERIFYING');
  if (entry.state === 'securing') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_SECURING');
  if (entry.state === 'drifted') return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_DRIFTED');
  if (entry.state !== 'live') return null;
  /*
   * Name the current binding before selection because choosing this live domain
   * moves it away from the app or device it serves.
   *
   * Asked through the shared predicate so this note, the confirmation below and
   * the bind pass cannot disagree about which choices are moves — and so the
   * slug comparison is canonicalized, which a bare `===` against CI-Cloud's
   * stored slug is not.
   */
  if (!customDomainServesAnotherApp(entry, currentAppSlug)) return null;
  if (entry.boundAppSlug) return `${t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE')} ${entry.boundAppSlug}`;
  return t('APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE_ELSEWHERE');
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
   * The portal's address, when this Hub has one. A domain another Hub holds
   * links to the page where it can be moved; without an address the remedy is
   * named but not linked.
   */
  portalUrl?: string | null;
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
  portalUrl,
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
   * only state a park can act on, and the only one where clearing the picker
   * does anything at all. Derived rather than passed in because the answer has to be
   * CI-Cloud's: `app.custom_domain` is a copy of it that goes stale between
   * syncs, and a stale copy would either hide the warning or show it for a
   * domain that has already gone.
   *
   * The hostname itself is never rendered — only whether there is one — so this
   * is a `some`, and it asks the shared predicate rather than a fourth
   * hand-rolled spelling of the same comparison.
   */
  const isServingCustomDomain = domains.some((entry) => entry.boundAppSlug !== null && !customDomainServesAnotherApp(entry, currentAppSlug));
  /*
   * The listed domains only the portal can move here, named in the note under
   * the picker. A certificate that failed for good is left out: a move would not
   * make it serve, and its option already says to reconnect it.
   */
  const heldByAnotherHub = domains.filter((entry) => customDomainHeldByAnotherHub(entry) && entry.state !== 'failed').map((entry) => entry.domain);
  const moveInPortalUrl = portalDomainsUrl(portalUrl);
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
                  if (entry && customDomainServesAnotherApp(entry, currentAppSlug)) {
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
                     * ⚠ SAY WHAT THE SAVE WILL DO, WHEN IT WILL DO SOMETHING.
                     * Clearing the picker for an app that is currently SERVING a
                     * domain takes that domain off the air; clearing it when
                     * nothing is bound changes nothing at all. Those are
                     * different sentences, and the neutral one for both would
                     * leave an operator unsure whether they had just stopped
                     * serving a customer's hostname.
                     *
                     * It is not irreversible — CI-Cloud parks the domain and the
                     * organization keeps it — so the copy says where it goes
                     * rather than warning about a loss that does not happen.
                     */
                    isServingCustomDomain
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
      {heldByAnotherHub.length > 0 ? (
        /*
         * ⚠ UNDER THE PICKER, NOT INSIDE THE OPTION. A disabled option takes no
         * pointer events, and the listbox moves focus between options only, so a
         * link placed in one could be read and never followed. It names the
         * domains, because it shows while the listbox is closed.
         */
        <p className="mt-1 text-xs text-muted-foreground" data-testid="custom-domain-held-elsewhere">
          {t('APP_INSTALL_FORM_CUSTOM_DOMAIN_ON_ANOTHER_HUB_HINT', { domains: heldByAnotherHub.join(', ') })}{' '}
          {moveInPortalUrl ? (
            <a href={moveInPortalUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
              {t('APP_INSTALL_FORM_CUSTOM_DOMAIN_MOVE_IN_PORTAL')}
            </a>
          ) : (
            t('APP_INSTALL_FORM_CUSTOM_DOMAIN_MOVE_IN_PORTAL')
          )}
        </p>
      ) : null}
    </div>
  );
}
