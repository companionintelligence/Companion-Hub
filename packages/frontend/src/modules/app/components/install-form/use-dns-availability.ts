import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { FieldValues, Path, UseFormClearErrors, UseFormSetError } from 'react-hook-form';

interface UseDnsAvailabilityParams<TFormValues extends FieldValues> {
  enabled: boolean;
  subdomain: string;
  selectedDomain?: string;
  checkDnsAvailability: (subdomain: string, selectedDomain?: string) => Promise<Response>;
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
  const lastDnsToastRef = useRef<string | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [dnsAvailabilityError, setDnsAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    if (dnsCheckTimeoutRef.current) {
      clearTimeout(dnsCheckTimeoutRef.current);
    }

    if (!enabled) {
      setDnsAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    if (!subdomain) {
      setDnsAvailabilityError(null);
      setIsCheckingDns(false);
      return;
    }

    setIsCheckingDns(true);
    setDnsAvailabilityError(null);

    dnsCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await checkDnsAvailability(subdomain, selectedDomain);

        if (response.ok) {
          const data = await response.json();
          if (data.available) {
            setDnsAvailabilityError(null);
            lastDnsToastRef.current = null;
            clearErrors('localSubdomain' as Path<TFormValues>);
          } else {
            const errorMessage =
              typeof data.message === 'string' && data.message ? data.message : t('APP_INSTALL_FORM_ERROR_DNS_NOT_AVAILABLE', { name: subdomain });
            setDnsAvailabilityError(errorMessage);
            if (lastDnsToastRef.current !== errorMessage) {
              lastDnsToastRef.current = errorMessage;
              toast.error(errorMessage);
            }
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
        setIsCheckingDns(false);
      }
    }, 500);

    return () => {
      if (dnsCheckTimeoutRef.current) {
        clearTimeout(dnsCheckTimeoutRef.current);
      }
    };
  }, [enabled, subdomain, selectedDomain, checkDnsAvailability, clearErrors, setError, t]);

  return {
    isCheckingDns,
    dnsAvailabilityError,
  };
}
