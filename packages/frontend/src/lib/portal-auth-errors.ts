export function portalErrorTranslationKey(portalError: string): string {
  switch (portalError) {
    case 'account_mismatch':
      return 'AUTH_PORTAL_ERROR_ACCOUNT_MISMATCH';
    case 'not_org_member':
      return 'AUTH_PORTAL_ERROR_NOT_ORG_MEMBER';
    case 'org_check_unavailable':
      return 'AUTH_PORTAL_ERROR_ORG_CHECK_UNAVAILABLE';
    case 'state_expired':
      return 'AUTH_PORTAL_ERROR_STATE_EXPIRED';
    case 'not_configured':
      return 'AUTH_PORTAL_ERROR_NOT_CONFIGURED';
    default:
      return 'AUTH_PORTAL_ERROR_CALLBACK_ERROR';
  }
}
