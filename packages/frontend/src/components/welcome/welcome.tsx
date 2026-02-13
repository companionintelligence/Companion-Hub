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
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <img
            alt="Companion Hub logo"
            src={getLogo(true)}
            height={80}
            width={80}
            className="mx-auto"
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
        </div>
        <Card className="w-full">
          <CardContent className="p-6">
            <h2 className="text-xl font-semibold text-center mb-2">Thanks for using Companion Hub</h2>
            <p className="text-sm text-muted-foreground text-center mb-6">Configure your preferences before getting started.</p>
            <div className="flex flex-col items-center gap-4">
              <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Enable error reporting" />
              <Button
                intent="primary"
                className="w-full"
                onClick={() => acknowledge.mutate({ body: { allowErrorMonitoring: errorMonitoring } })}
                loading={acknowledge.isPending}
                disabled={acknowledge.isPending}
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
