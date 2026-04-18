import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';

type ProvisioningPhase = 'unregistered' | 'paired' | 'provisioning' | 'locally_ready' | 'publicly_ready' | 'degraded';

type DegradedReason = 'tunnel_token_missing' | 'tunnel_unreachable' | 'cloud_validation_failed';

interface RegistrationStatus {
  phase: ProvisioningPhase;
  degradedReasons: DegradedReason[];
  /** Backward-compat: true when phase is locally_ready, publicly_ready, or degraded. */
  registered: boolean;
}

export const useRegistrationStatus = () => {
  return useQuery<RegistrationStatus>({
    queryKey: ['registration', 'status'],
    queryFn: async () => {
      const res = await apiFetch('/api/registration/status');
      if (!res.ok) {
        throw new Error('Failed to fetch registration status');
      }
      return res.json();
    },
    refetchInterval: 5000, // Check every 5 seconds
    retry: false,
  });
};
