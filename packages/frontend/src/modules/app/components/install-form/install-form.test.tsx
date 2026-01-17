import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { InstallForm } from './install-form';
import { useAppContext } from '@/context/app-context';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mocks
vi.mock('@/context/app-context', () => ({
  useAppContext: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
}));

// Mock API client if needed
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getRandomPortMutation: () => ({ mutationFn: vi.fn() }),
}));

describe('InstallForm', () => {
  it('should display organization slug in subdomain suffix when present', () => {
    (useAppContext as any).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'Josh', // Case insensitive check
        localDomain: 'tipi.lan',
        maxBackups: 5,
        guestDashboard: false,
      },
      isProduction: true,
    });

    const mockInfo: any = {
      urn: 'app:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    };

    render(<InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />);

    // Expect to see "-josh.ci.computer" (lowercased)
    expect(screen.getByText(/-josh.ci.computer/)).toBeInTheDocument();
  });

  it('should fallback to local domain when organization slug is missing', () => {
    (useAppContext as any).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: undefined,
        localDomain: 'tipi.lan',
        maxBackups: 5,
        guestDashboard: false,
      },
      isProduction: true,
    });

    const mockInfo: any = {
      urn: 'app:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    };

    render(<InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />);

    // Expect to see "-tipi.lan"
    expect(screen.getByText(/-tipi.lan/)).toBeInTheDocument();
  });
});
