/**
 * The password an operator sets on this Hub. Register, reset, and the auth
 * service all use this so a form cannot accept a password the server rejects.
 * At least 8 characters, with an uppercase letter, a lowercase letter, a
 * digit, and a symbol.
 */
export const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

export function meetsPasswordComplexity(password: string): boolean {
  return PASSWORD_COMPLEXITY_REGEX.test(password);
}
