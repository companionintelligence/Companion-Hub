import { acknowledgeWelcomeMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { getLogo } from '@/lib/theme/theme';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

type Props = {
  allowErrorMonitoring: boolean;
};

export const Welcome = ({ allowErrorMonitoring }: Props) => {
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);

  const acknowledge = useMutation({
    ...acknowledgeWelcomeMutation(),
  });

  return (
    <div className="page page-center">
      <div className="container container-tight py-4">
        <div className="text-center mb-4">
          <img
            alt="Companion Hub logo"
            src={getLogo(true)}
            height={128}
            width={128}
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
        </div>
        <Card className="max-w-md mx-auto">
          <CardContent>
            <h2 className="text-2xl font-bold text-center mb-4">Thanks for using Companion Hub</h2>
            <div className="flex flex-col items-center">
              <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Enable error reporting" />
              <Button
                intent="primary"
                className="mt-3"
                onClick={() => acknowledge.mutate({ body: { allowErrorMonitoring: errorMonitoring } })}
                loading={acknowledge.isPending || acknowledge.isPending}
                disabled={acknowledge.isPending || acknowledge.isPending}
              >
                Save and enter
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
