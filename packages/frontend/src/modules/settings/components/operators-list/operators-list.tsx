import { client } from '@/api-client/client.gen';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';

type HubOperator = {
  id: number;
  username: string;
  orgRole: 'owner' | 'admin' | 'member' | null;
  accessStatus: 'active' | 'revoked';
  membershipCheckedAt: string | null;
  localPasswordSet: boolean;
};

export const OperatorsList = () => {
  const { t } = useTranslation();
  const operators = useQuery({
    queryKey: ['hub-operators'],
    queryFn: async () => {
      const { data, error } = await client.get({ url: '/api/auth/operators' });
      if (error) {
        throw error;
      }
      return (data as { operators?: HubOperator[] } | undefined)?.operators ?? [];
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 shrink-0 text-muted-foreground" />
          <CardTitle className="text-xl">{t('SETTINGS_SECURITY_OPERATORS_TITLE')}</CardTitle>
        </div>
        <CardDescription>{t('SETTINGS_SECURITY_OPERATORS_SUBTITLE')}</CardDescription>
      </CardHeader>
      <CardContent>
        {operators.isError ? (
          <p className="text-sm text-muted-foreground">{t('COMMON_AN_ERROR_OCCURRED')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('AUTH_FORM_EMAIL')}</th>
                  <th className="py-2 pr-3 font-medium">{t('SETTINGS_SECURITY_OPERATORS_ROLE')}</th>
                  <th className="py-2 pr-3 font-medium">{t('SETTINGS_SECURITY_OPERATORS_STATUS')}</th>
                  <th className="py-2 pr-3 font-medium">{t('SETTINGS_SECURITY_OPERATORS_LAST_CHECK')}</th>
                  <th className="py-2 font-medium">{t('SETTINGS_SECURITY_OPERATORS_OFFLINE_PASSWORD')}</th>
                </tr>
              </thead>
              <tbody>
                {(operators.data ?? []).map((operator) => (
                  <tr key={operator.id} className="border-b last:border-0" data-testid="hub-operator-row">
                    <td className="py-2 pr-3">{operator.username}</td>
                    <td className="py-2 pr-3">{operator.orgRole ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {t(
                        operator.accessStatus === 'revoked'
                          ? 'SETTINGS_SECURITY_OPERATORS_STATUS_REVOKED'
                          : 'SETTINGS_SECURITY_OPERATORS_STATUS_ACTIVE',
                      )}
                    </td>
                    <td className="py-2 pr-3">{operator.membershipCheckedAt ? new Date(operator.membershipCheckedAt).toLocaleString() : '—'}</td>
                    <td className="py-2">
                      {t(operator.localPasswordSet ? 'SETTINGS_SECURITY_OPERATORS_OFFLINE_YES' : 'SETTINGS_SECURITY_OPERATORS_OFFLINE_NO')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
