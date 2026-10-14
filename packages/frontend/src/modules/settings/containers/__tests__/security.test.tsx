import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../components/change-username-form/change-username-form', () => ({ ChangeUsernameForm: () => <div>Username form</div> }));
vi.mock('../../components/change-password-form/change-password-form', () => ({ ChangePasswordForm: () => <div>Password form</div> }));
vi.mock('../../components/otp-form/otp-form', () => ({ OtpForm: () => <div>Two-factor form</div> }));
vi.mock('../../components/operators-list/operators-list', () => ({ OperatorsList: () => <div>Operators</div> }));
vi.mock('../api-keys', () => ({ ApiKeysContainer: () => <div>API keys</div> }));

import { SecurityContainer } from '../security';

describe('SecurityContainer', () => {
  it("shows an owner or admin the Hub's API keys", () => {
    render(<SecurityContainer totpEnabled={false} username="owner@example.com" manageHub />);

    expect(screen.getByText('API keys')).toBeInTheDocument();
  });

  // The Hub's API keys are an owner's or admin's to create, change and revoke.
  it('shows a member their own account and the operators, without the API keys', () => {
    render(<SecurityContainer totpEnabled={false} username="member@example.com" manageHub={false} />);

    expect(screen.getByText('Username form')).toBeInTheDocument();
    expect(screen.getByText('Password form')).toBeInTheDocument();
    expect(screen.getByText('Two-factor form')).toBeInTheDocument();
    expect(screen.getByText('Operators')).toBeInTheDocument();
    expect(screen.queryByText('API keys')).not.toBeInTheDocument();
  });
});
