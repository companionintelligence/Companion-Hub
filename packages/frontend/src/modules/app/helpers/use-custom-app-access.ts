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

/** The organization role the Hub stored at sign-in, for saying why an action is withheld. */
export type OrganizationRole = 'owner' | 'admin' | 'member';

interface CustomAppAccess {
  actions: readonly CustomAppAction[];
  role: OrganizationRole | null;
}

const NONE: readonly CustomAppAction[] = [];
const NO_ACCESS: CustomAppAccess = { actions: NONE, role: null };

const fetchCustomAppAccess = async (): Promise<CustomAppAccess> => {
  const res = await apiFetch('/api/custom-apps/access');
  if (!res.ok) {
    return NO_ACCESS;
  }
  const body = (await res.json()) as { actions?: unknown; role?: unknown };
  const actions = Array.isArray(body.actions) ? (body.actions.filter((action) => typeof action === 'string') as CustomAppAction[]) : NONE;
  const role = body.role === 'owner' || body.role === 'admin' || body.role === 'member' ? body.role : null;
  return { actions, role };
};

/**
 * What the signed-in person may do to a custom app, or to an app from a store the operator added
 * (the Hub decides those the same way): every verb for an organization owner or admin, start, stop
 * and restart for an account with no linked Portal identity, and only view for a member. Creating a
 * custom app takes `install`. The app pages show the actions outside this disabled, with the reason
 * (`AppActions`); the Hub still decides every call, however it is made.
 *
 * The Hub answers from the role it stored at sign-in, without a Portal call, so the page's controls
 * show at once; each action still asks the Portal. The answer is kept for a minute. Until it arrives,
 * and when it fails, nothing beyond the view is offered. `enabled: false` asks nothing (an app from
 * the official store, whose grants the Portal decides per app).
 */
export function useCustomAppAccess(options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ['custom-app-access'],
    queryFn: fetchCustomAppAccess,
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
  const actions = query.data?.actions ?? NONE;

  return {
    actions,
    role: query.data?.role ?? null,
    may: (action: CustomAppAction) => actions.includes(action),
  };
}
