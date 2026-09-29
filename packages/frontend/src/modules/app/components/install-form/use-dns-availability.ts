import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { FieldValues, Path, UseFormClearErrors, UseFormSetError } from 'react-hook-form';
import type { DnsAvailabilityResponse } from '@/lib/cloudflare-api';

interface UseDnsAvailabilityParams<TFormValues extends FieldValues> {
  enabled: boolean;
  subdomain: string;
  selectedDomain?: string;
  checkDnsAvailability: (subdomain: string, selectedDomain?: string) => Promise<DnsAvailabilityResponse>;
  setError: UseFormSetError<TFormValues>;
  clearErrors: UseFormClearErrors<TFormValues>;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export function useDnsAvailability<TFormValues extends FieldValues>({
  enabled,
  subdomain,
  selectedDomain,
  checkDnsAvailability,
  setError,
  clearErrors,
  t,
}: UseDnsAvailabilityParams<TFormValues>) {
  const dnsCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /*
   * ⚠ ONLY THE LATEST CHECK MAY ANSWER. Clearing the debounce timer stops a
   * check that has not been sent, not one already in flight. A form opens with
   * the Hub's own domain and moves to the domain Portal preselects a moment
   * later, so two checks overlap — and when the first is for a zone that takes
   * no new names (a Hub on `ci.computer`), its late refusal landed on the
   * domain the form now shows. Each run of the effect gets its own number, and
   * an answer for any other number is dropped.
   */
  const latestCheckRef = useRef(0);
  const lastDnsToastRef = useRef<string | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [dnsAvailabilityError, setDnsAvailabilityError] = useState<string | null>(null);
  const [domainAvailabilityError, setDomainAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    const check = latestCheckRef.current;
    const isCurrent = () => check === latestCheckRef.current;

    if (dnsCheckTimeoutRef.current) {
      clearTimeout(dnsCheckTimeoutRef.current);
    }

    if (!enabled) {
      setDnsAvailabilityError(null);
      setDomainAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    if (!subdomain) {
      setDnsAvailabilityError(null);
      setDomainAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    setIsCheckingDns(true);
    setDnsAvailabilityError(null);
    setDomainAvailabilityError(null);

    dnsCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await checkDnsAvailability(subdomain, selectedDomain);

        if (!isCurrent()) {
          return;
        }

        if (response.ok) {
          const data = await response.json();

          if (!isCurrent()) {
            return;
          }

          if (data.available) {
            setDnsAvailabilityError(null);
            setDomainAvailabilityError(null);
            lastDnsToastRef.current = null;
            clearErrors('localSubdomain' as Path<TFormValues>);
            clearErrors('publicDomain' as Path<TFormValues>);
          } else if (data.reason === 'zone_unreachable') {
            const errorMessage = typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DOMAIN_UNAVAILABLE');
            setDnsAvailabilityError(null);
            setDomainAvailabilityError(errorMessage);
            if (lastDnsToastRef.current !== errorMessage) {
              lastDnsToastRef.current = errorMessage;
              toast.error(errorMessage);
            }
            clearErrors('localSubdomain' as Path<TFormValues>);
            setError('publicDomain' as Path<TFormValues>, {
              type: 'manual',
              message: errorMessage,
            });
          } else {
            const errorMessage =
              typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE', { name: subdomain });
            setDomainAvailabilityError(null);
            setDnsAvailabilityError(errorMessage);
            if (lastDnsToastRef.current !== errorMessage) {
              lastDnsToastRef.current = errorMessage;
              toast.error(errorMessage);
            }
            clearErrors('publicDomain' as Path<TFormValues>);
            setError('localSubdomain' as Path<TFormValues>, {
              type: 'manual',
              message: errorMessage,
            });
          }
        } else {
          console.warn('DNS availability check failed:', response.status);
        }
      } catch (error) {
        console.error('Failed to check DNS availability:', error);
      } finally {
        if (isCurrent()) {
          setIsCheckingDns(false);
        }
      }
    }, 500);

    return () => {
      latestCheckRef.current += 1;

      if (dnsCheckTimeoutRef.current) {
        clearTimeout(dnsCheckTimeoutRef.current);
      }
    };
  }, [enabled, subdomain, selectedDomain, checkDnsAvailability, clearErrors, setError, t]);

  return {
    isCheckingDns,
    dnsAvailabilityError,
    domainAvailabilityError,
  };
}
