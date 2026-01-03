import { useQuery } from '@tanstack/react-query';

interface RegistrationStatus {
  registered: boolean;
}

export const useRegistrationStatus = () => {
  return useQuery<RegistrationStatus>({
    queryKey: ['registration', 'status'],
    queryFn: async () => {
      const res = await fetch('/api/registration/status');
      if (!res.ok) {
        throw new Error('Failed to fetch registration status');
      }
      return res.json();
    },
    refetchInterval: 5000, // Check every 5 seconds
    retry: false,
  });
};
