import { Show, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Card, CardContent } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';

interface EmptyPageProps {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  redirectPath?: string;
  extraContent?: JSX.Element;
}

export function EmptyPage(props: EmptyPageProps) {
  const navigate = useNavigate();

  return (
    <Card>
      <CardContent class="flex flex-col items-center justify-center p-8 text-center">
        <img src="/empty.svg" alt="Empty" height="80" width="80" class="mb-3 opacity-50" style={{ "max-width": '100%', height: '80px' }} />
        <p class="text-xl font-medium">{props.title}</p>
        <Show when={props.subtitle}>
          <p class="text-muted-foreground">{props.subtitle}</p>
        </Show>
        <Show when={props.extraContent}>{props.extraContent}</Show>
        <Show when={props.redirectPath && props.actionLabel}>
          <div class="mt-4">
            <Button onClick={() => navigate(props.redirectPath ?? '')}>{props.actionLabel}</Button>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
}
