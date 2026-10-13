import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';

/** A Hub verb, as `GET /api/custom-apps/access` names it. */
export type CustomAppAction =
  | 'view'
  | 'start'
  | 'stop'
  | 'restart'
  | 'install'
  | 'update'
  | 'uninstall'
  | 'reset'
  | 'backup'
  | 'restore'
  | 'configure';

const NONE: readonly CustomAppAction[] = [];

const fetchCustomAppAccess = async (): Promise<readonly CustomAppAction[]> => {
  const res = await apiFetch('/api/custom-apps/access');
  if (!res.ok) {
    return NONE;
  }
  const body = (await res.json()) as { actions?: unknown };
  return Array.isArray(body.actions) ? (body.actions.filter((action) => typeof action === 'string') as CustomAppAction[]) : NONE;
};

/**
 * What the signed-in person may do to a custom app: every verb for an organization owner or admin,
 * start, stop and restart for an account with no linked Portal identity, and only view for a member.
 * Creating a custom app takes `install`. The custom app page and the App Store offer only these, so a
 * member meets no button the Hub would refuse; the Hub still decides every call.
 *
 * The Hub answers from the role it stored at sign-in, without a Portal call, so the page's controls
 * show at once; each action still asks the Portal. The answer is kept for a minute. Until it arrives,
 * and when it fails, nothing beyond the view is offered.
 */
export function useCustomAppAccess() {
  const query = useQuery({
    queryKey: ['custom-app-access'],
    queryFn: fetchCustomAppAccess,
    staleTime: 60_000,
  });
  const actions = query.data ?? NONE;

  return {
    actions,
    may: (action: CustomAppAction) => actions.includes(action),
  };
}
